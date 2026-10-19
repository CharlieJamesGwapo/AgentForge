import { isDeepStrictEqual } from 'node:util';
import { ProviderError } from './errors.js';
import { redact } from '../shared/safety.js';
import { createToolSession as createToolSessionWithCodec } from './tools.js';
import {
  getCredential,
  requestJson,
  validateBaseUrl,
  validatePrompt,
  validateProviderOptions,
} from './http.js';
import { finalizeStream, finishPrompt, prepareSchema } from './output.js';
import { requestEvents } from './streaming.js';
import { cloneToolJson } from './tools.js';
import type {
  AdapterCapabilities,
  AdapterHealth,
  PromptInput,
  PromptResult,
  PromptStreamEvent,
  ProviderAdapter,
  ProviderOptions,
  RequestOptions,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolSession,
  ToolSessionInput,
  ToolRequestOptions,
  ToolTurn,
} from './types.js';
import type { NativeToolStreamEvent, ToolCodec } from './tools.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

type OllamaTags = { models: Array<{ name: string }> };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(detail: string): ProviderError {
  return new ProviderError(
    'invalid-response',
    `Ollama returned an invalid response: ${detail}`,
  );
}

function parseTags(value: unknown): OllamaTags {
  if (!isRecord(value) || !Array.isArray(value.models))
    throw invalidResponse('expected a models array.');
  const models: OllamaTags['models'] = [];
  for (const entry of value.models) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      entry.name.length === 0
    )
      throw invalidResponse('each model entry must include a non-empty name.');
    models.push({ name: entry.name });
  }
  return { models };
}

function modelIsPresent(configured: string, reported: string[]): boolean {
  if (reported.includes(configured)) return true;
  // Ollama treats an untagged model reference as its :latest tag.
  const lastSegment = configured.slice(configured.lastIndexOf('/') + 1);
  return (
    !lastSegment.includes(':') && reported.includes(`${configured}:latest`)
  );
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseChatResponse(value: unknown): PromptResult {
  if (!isRecord(value) || Object.hasOwn(value, 'error'))
    throw invalidResponse('expected a completed chat response.');
  if (
    typeof value.model !== 'string' ||
    value.model.length === 0 ||
    !isRecord(value.message) ||
    value.message.role !== 'assistant' ||
    typeof value.message.content !== 'string' ||
    value.done !== true
  ) {
    throw invalidResponse(
      'expected a reported model, assistant message, and done=true.',
    );
  }
  if (Object.hasOwn(value.message, 'tool_calls'))
    throw invalidResponse('tool calls are not supported.');

  let finishReason: PromptResult['finishReason'] = 'completed';
  if (value.done_reason !== undefined) {
    if (value.done_reason === 'length') finishReason = 'length';
    else if (value.done_reason === 'refusal') finishReason = 'refusal';
    else if (value.done_reason !== 'stop')
      throw invalidResponse('the completion reason is not supported.');
  }
  if (value.message.content.length === 0 && finishReason === 'completed')
    throw invalidResponse('the assistant message is empty.');

  const usage =
    validCounter(value.prompt_eval_count) && validCounter(value.eval_count)
      ? {
          status: 'available' as const,
          inputTokens: value.prompt_eval_count,
          outputTokens: value.eval_count,
        }
      : { status: 'unavailable' as const };

  return {
    text: value.message.content,
    model: value.model,
    finishReason,
    usage,
  };
}

function parseToolChatResponse(value: unknown): {
  turn: ToolTurn;
  continuation: unknown[];
} {
  if (
    !isRecord(value) ||
    Object.hasOwn(value, 'error') ||
    typeof value.model !== 'string' ||
    value.model.length === 0 ||
    !isRecord(value.message) ||
    value.message.role !== 'assistant' ||
    typeof value.message.content !== 'string' ||
    value.done !== true
  ) {
    throw invalidResponse(
      'expected a completed assistant chat response with done=true.',
    );
  }

  let nativeCalls: unknown[] = [];
  if (Object.hasOwn(value.message, 'tool_calls')) {
    if (!Array.isArray(value.message.tool_calls))
      throw invalidResponse('assistant tool calls must be an array.');
    if (value.message.tool_calls.length > 16)
      throw invalidResponse('the assistant returned too many tool calls.');
    nativeCalls = value.message.tool_calls;
  }

  if (
    Object.hasOwn(value.message, 'thinking') &&
    typeof value.message.thinking !== 'string'
  )
    throw invalidResponse('assistant thinking must be a string.');

  let finishReason: ToolTurn['finishReason'] = 'completed';
  if (value.done_reason === 'length') finishReason = 'length';
  else if (value.done_reason === 'refusal') finishReason = 'refusal';
  else if (value.done_reason !== undefined && value.done_reason !== 'stop')
    throw invalidResponse('the completion reason is not supported.');

  const suppliedIds = new Set<string>();
  for (const nativeCall of nativeCalls) {
    if (!isRecord(nativeCall))
      throw invalidResponse('each assistant tool call must be an object.');
    if (!Object.hasOwn(nativeCall, 'id')) continue;
    if (
      typeof nativeCall.id !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,200}$/.test(nativeCall.id) ||
      suppliedIds.has(nativeCall.id)
    )
      throw invalidResponse(
        'assistant tool call ids must be unique and valid.',
      );
    suppliedIds.add(nativeCall.id);
  }

  const usedIds = new Set(suppliedIds);
  const calls: ToolCall[] = nativeCalls.map((nativeCall, index) => {
    if (
      !isRecord(nativeCall) ||
      (nativeCall.type !== undefined && nativeCall.type !== 'function') ||
      !isRecord(nativeCall.function)
    )
      throw invalidResponse(
        'each assistant tool call must include a function.',
      );
    const name = nativeCall.function.name;
    const args = nativeCall.function.arguments;
    if (typeof name !== 'string' || name.length === 0 || !isRecord(args))
      throw invalidResponse(
        'each assistant tool call must include a function name and object arguments.',
      );

    let id: string;
    if (typeof nativeCall.id === 'string') id = nativeCall.id;
    else {
      id = `ollama-call-${index + 1}`;
      let suffix = 1;
      while (usedIds.has(id)) id = `ollama-call-${index + 1}-${suffix++}`;
      usedIds.add(id);
    }
    return { id, name, arguments: args };
  });

  if (calls.length > 0) {
    if (finishReason === 'length' || finishReason === 'refusal')
      throw invalidResponse(
        'tool calls from incomplete or refused responses cannot be used.',
      );
    finishReason = 'tool-calls';
  } else if (
    finishReason === 'completed' &&
    value.message.content.length === 0
  ) {
    throw invalidResponse('the assistant message is empty.');
  }

  const usage =
    validCounter(value.prompt_eval_count) && validCounter(value.eval_count)
      ? {
          status: 'available' as const,
          inputTokens: value.prompt_eval_count,
          outputTokens: value.eval_count,
        }
      : { status: 'unavailable' as const };

  const continuationMessage: Record<string, unknown> = {
    role: 'assistant',
    content: value.message.content,
  };
  if (Object.hasOwn(value.message, 'thinking'))
    continuationMessage.thinking = value.message.thinking;
  if (Object.hasOwn(value.message, 'tool_calls'))
    continuationMessage.tool_calls = nativeCalls;

  return {
    turn: {
      text: value.message.content,
      model: value.model,
      finishReason,
      calls,
      usage,
    },
    continuation: calls.length > 0 ? [continuationMessage] : [],
  };
}

type OllamaToolStreamFrame = {
  model: string;
  content: string;
  thinking?: string;
  toolCalls: unknown[];
  hasToolCalls: boolean;
  done: boolean;
};

type NativeCallAccumulator = {
  index?: number;
  id?: string;
  type?: 'function';
  name?: string;
  arguments?: Record<string, unknown>;
};

function parseToolStreamFrame(value: unknown): OllamaToolStreamFrame {
  if (
    !isRecord(value) ||
    Object.hasOwn(value, 'error') ||
    typeof value.model !== 'string' ||
    value.model.length === 0 ||
    !isRecord(value.message) ||
    value.message.role !== 'assistant' ||
    typeof value.message.content !== 'string' ||
    typeof value.done !== 'boolean'
  )
    throw invalidResponse('expected a valid assistant tool stream frame.');

  if (
    Object.hasOwn(value.message, 'thinking') &&
    typeof value.message.thinking !== 'string'
  )
    throw invalidResponse('assistant thinking must be a string.');

  const hasToolCalls = Object.hasOwn(value.message, 'tool_calls');
  let toolCalls: unknown[] = [];
  if (hasToolCalls) {
    if (!Array.isArray(value.message.tool_calls))
      throw invalidResponse('assistant tool calls must be an array.');
    if (value.message.tool_calls.length > 16)
      throw invalidResponse('the assistant returned too many tool calls.');
    toolCalls = value.message.tool_calls;
  }

  return {
    model: value.model,
    content: value.message.content,
    ...(typeof value.message.thinking === 'string'
      ? { thinking: value.message.thinking }
      : {}),
    toolCalls,
    hasToolCalls,
    done: value.done,
  };
}

function mergeArgumentObjects(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = Object.assign(
    Object.create(null) as Record<string, unknown>,
    previous,
  );
  for (const [key, value] of Object.entries(incoming)) {
    if (!Object.hasOwn(previous, key)) {
      merged[key] = value;
      continue;
    }

    const current = previous[key];
    if (isRecord(current) && isRecord(value)) {
      merged[key] = mergeArgumentObjects(current, value);
      continue;
    }
    if (!isDeepStrictEqual(current, value))
      throw invalidResponse('indexed tool call arguments conflict.');
  }
  return merged;
}

function collectNativeToolCalls(
  rawCalls: unknown[],
  calls: NativeCallAccumulator[],
  indexedCalls: Map<number, NativeCallAccumulator>,
): void {
  for (const rawCall of rawCalls) {
    if (
      !isRecord(rawCall) ||
      Object.keys(rawCall).some(
        (key) => !['id', 'type', 'function'].includes(key),
      ) ||
      (rawCall.type !== undefined && rawCall.type !== 'function') ||
      !isRecord(rawCall.function) ||
      Object.keys(rawCall.function).some(
        (key) => !['index', 'name', 'arguments'].includes(key),
      )
    )
      throw invalidResponse(
        'each assistant tool call must include a function.',
      );

    const nativeFunction = rawCall.function;
    const hasIndex = Object.hasOwn(nativeFunction, 'index');
    if (
      hasIndex &&
      (!Number.isSafeInteger(nativeFunction.index) ||
        (nativeFunction.index as number) < 0)
    )
      throw invalidResponse(
        'assistant tool call indices must be non-negative integers.',
      );
    if (
      Object.hasOwn(rawCall, 'id') &&
      (typeof rawCall.id !== 'string' ||
        !/^[a-zA-Z0-9_.:-]{1,200}$/.test(rawCall.id))
    )
      throw invalidResponse('assistant tool call ids must be valid.');
    if (
      Object.hasOwn(nativeFunction, 'name') &&
      (typeof nativeFunction.name !== 'string' ||
        nativeFunction.name.length === 0)
    )
      throw invalidResponse(
        'assistant tool call names must be non-empty strings.',
      );
    if (
      Object.hasOwn(nativeFunction, 'arguments') &&
      !isRecord(nativeFunction.arguments)
    )
      throw invalidResponse('assistant tool call arguments must be an object.');

    const index = hasIndex ? (nativeFunction.index as number) : undefined;
    const accumulated =
      index === undefined ? undefined : indexedCalls.get(index);
    if (!accumulated && calls.length >= 16)
      throw invalidResponse('the assistant returned too many tool calls.');

    const target = accumulated ?? {
      ...(index === undefined ? {} : { index }),
    };
    const incomingId = typeof rawCall.id === 'string' ? rawCall.id : undefined;
    const incomingName =
      typeof nativeFunction.name === 'string' ? nativeFunction.name : undefined;
    if (
      target.id !== undefined &&
      incomingId !== undefined &&
      target.id !== incomingId
    )
      throw invalidResponse('an indexed tool call changed its id.');
    if (
      target.name !== undefined &&
      incomingName !== undefined &&
      target.name !== incomingName
    )
      throw invalidResponse('an indexed tool call changed its function name.');

    if (incomingId !== undefined) target.id = incomingId;
    if (rawCall.type === 'function') target.type = 'function';
    if (incomingName !== undefined) target.name = incomingName;
    if (isRecord(nativeFunction.arguments)) {
      target.arguments = target.arguments
        ? mergeArgumentObjects(target.arguments, nativeFunction.arguments)
        : nativeFunction.arguments;
    }

    if (!accumulated) {
      calls.push(target);
      if (index !== undefined) indexedCalls.set(index, target);
    }
  }
}

function completeNativeToolCalls(
  calls: NativeCallAccumulator[],
): Record<string, unknown>[] {
  return calls.map((call) => {
    if (typeof call.name !== 'string' || !isRecord(call.arguments))
      throw invalidResponse(
        'each assistant tool call must include a function name and object arguments.',
      );
    return {
      ...(call.id === undefined ? {} : { id: call.id }),
      ...(call.type === undefined ? {} : { type: call.type }),
      function: {
        ...(call.index === undefined ? {} : { index: call.index }),
        name: call.name,
        arguments: call.arguments,
      },
    };
  });
}

function parseStreamFrame(value: unknown): {
  model: string;
  content: string;
  done: boolean;
} {
  if (
    !isRecord(value) ||
    Object.hasOwn(value, 'error') ||
    typeof value.model !== 'string' ||
    value.model.length === 0 ||
    !isRecord(value.message) ||
    value.message.role !== 'assistant' ||
    typeof value.message.content !== 'string' ||
    typeof value.done !== 'boolean'
  )
    throw invalidResponse('expected a valid assistant stream frame.');
  if (Object.hasOwn(value.message, 'tool_calls'))
    throw invalidResponse('tool calls are not supported.');
  return {
    model: value.model,
    content: value.message.content,
    done: value.done,
  };
}

export class OllamaAdapter implements ProviderAdapter {
  readonly id = 'ollama';
  readonly version = '1.0.0';
  readonly kind = 'model-provider' as const;

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKeyEnv?: string;
  private readonly maxOutputTokens: number;

  constructor(options: ProviderOptions) {
    const validated = validateProviderOptions(options, DEFAULT_BASE_URL);
    this.model = validated.model;
    this.baseUrl = validateBaseUrl(validated.baseUrl);
    this.apiKeyEnv = validated.apiKeyEnv;
    this.maxOutputTokens = validated.maxOutputTokens;
  }

  capabilities(): AdapterCapabilities {
    return {
      promptSubmission: true,
      structuredResponses: true,
      streaming: true,
      toolInvocation: true,
      toolStreaming: true,
      usageTelemetry: true,
      cancellation: true,
    };
  }

  async health(): Promise<AdapterHealth> {
    const authentication = this.authenticationState();
    return {
      status: authentication === 'missing' ? 'unavailable' : 'available',
      authentication,
      connection: 'not-checked',
      detail:
        authentication === 'missing'
          ? 'Ollama is configured, but its required API credential is missing; connection and model readiness have not been checked.'
          : 'Ollama configuration is ready; connection and model readiness have not been checked.',
    };
  }

  async checkConnection(input: RequestOptions): Promise<AdapterHealth> {
    const credential = this.credential();
    const headers = this.authorizationHeaders(credential);
    const value = await requestJson({
      url: this.endpoint('/api/tags'),
      method: 'GET',
      headers,
      timeoutMs: input.timeoutMs,
      approved: input.approved,
      signal: input.signal,
    });
    const models = parseTags(value).models.map(({ name }) => name);
    const present = modelIsPresent(this.model, models);
    const safeModel = redact(this.model, credential ? [credential] : []);
    return {
      status: present ? 'available' : 'unavailable',
      authentication: this.authenticationState(),
      connection: 'verified',
      detail: present
        ? `Ollama is reachable and model ${safeModel} is available.`
        : `Ollama is reachable, but model ${safeModel} is not available; no model was downloaded.`,
    };
  }

  readonly submitPrompt: NonNullable<ProviderAdapter['submitPrompt']> = async (
    input: PromptInput,
  ): Promise<PromptResult> => {
    validatePrompt(input);
    const format =
      input.responseSchema === undefined
        ? undefined
        : prepareSchema(input.responseSchema);
    const normalizedInput: PromptInput = {
      ...input,
      ...(format === undefined ? {} : { responseSchema: format }),
    };
    const credential = this.credential();
    const headers = {
      'content-type': 'application/json',
      ...(this.authorizationHeaders(credential) ?? {}),
    };
    const value = await requestJson({
      url: this.endpoint('/api/chat'),
      method: 'POST',
      headers,
      body: {
        model: this.model,
        messages: [{ role: 'user', content: normalizedInput.prompt }],
        stream: false,
        options: { num_predict: this.maxOutputTokens },
        ...(format === undefined ? {} : { format }),
      },
      timeoutMs: normalizedInput.timeoutMs,
      approved: normalizedInput.approved,
      signal: normalizedInput.signal,
    });
    return finishPrompt(parseChatResponse(value), normalizedInput, credential);
  };

  readonly createToolSession: NonNullable<
    ProviderAdapter['createToolSession']
  > = (input: ToolSessionInput): ToolSession => {
    const credential = this.credential();
    const headers = {
      'content-type': 'application/json',
      ...(this.authorizationHeaders(credential) ?? {}),
    };
    const codec: ToolCodec = {
      initial: (prompt) => [{ role: 'user', content: prompt }],
      request: async (history, tools, options) =>
        requestJson({
          url: this.endpoint('/api/chat'),
          method: 'POST',
          headers,
          body: {
            model: this.model,
            messages: history,
            stream: false,
            options: { num_predict: this.maxOutputTokens },
            tools: tools.map((tool: ToolDefinition) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            ...(options.responseSchema === undefined
              ? {}
              : { format: options.responseSchema }),
          },
          timeoutMs: options.timeoutMs,
          approved: options.approved,
          signal: options.signal,
        }),
      stream: (history, tools, options) =>
        this.streamToolChat(history, tools, options, headers),
      parse: parseToolChatResponse,
      append: (
        history: unknown[],
        continuation: unknown[],
        results: ToolResult[],
        calls: ToolCall[],
      ) => [
        ...history,
        ...continuation,
        ...calls.map((call, index) => ({
          role: 'tool',
          tool_name: call.name,
          content: results[index]!.output,
        })),
      ],
    };
    return createToolSessionWithCodec(input, codec, credential);
  };

  private async *streamToolChat(
    history: unknown[],
    tools: ToolDefinition[],
    options: ToolRequestOptions,
    headers: Record<string, string>,
  ): AsyncGenerator<NativeToolStreamEvent> {
    const events = requestEvents({
      url: this.endpoint('/api/chat'),
      method: 'POST',
      headers,
      body: {
        model: this.model,
        messages: history,
        stream: true,
        options: { num_predict: this.maxOutputTokens },
        tools: tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        ...(options.responseSchema === undefined
          ? {}
          : { format: options.responseSchema }),
      },
      timeoutMs: options.timeoutMs,
      approved: options.approved,
      signal: options.signal,
      format: 'ndjson',
    });

    const content: string[] = [];
    const calls: NativeCallAccumulator[] = [];
    const indexedCalls = new Map<number, NativeCallAccumulator>();
    let thinking = '';
    let hasThinking = false;
    let hasToolCalls = false;
    let reportedModel: string | undefined;
    let terminal: Record<string, unknown> | undefined;

    for await (const event of events) {
      if (terminal)
        throw invalidResponse('the stream continued after a done=true frame.');
      const frame = parseToolStreamFrame(event.data);
      if (reportedModel === undefined) reportedModel = frame.model;
      else if (frame.model !== reportedModel)
        throw invalidResponse('the reported model changed during streaming.');

      content.push(frame.content);
      if (frame.thinking !== undefined) {
        thinking += frame.thinking;
        hasThinking = true;
      }
      if (frame.hasToolCalls) {
        hasToolCalls = true;
        collectNativeToolCalls(
          cloneToolJson(frame.toolCalls, 262144),
          calls,
          indexedCalls,
        );
      }
      if (frame.done) {
        if (!isRecord(event.data))
          throw invalidResponse('expected a valid terminal assistant frame.');
        terminal = event.data;
      }
      if (frame.content.length > 0)
        yield { type: 'text-delta', text: frame.content };
    }

    if (!terminal || !reportedModel)
      throw invalidResponse('the stream ended before a done=true frame.');

    const terminalMessage: Record<string, unknown> = {
      role: 'assistant',
      content: content.join(''),
    };
    if (hasThinking) terminalMessage.thinking = thinking;
    if (hasToolCalls)
      terminalMessage.tool_calls = completeNativeToolCalls(calls);
    const response = {
      ...terminal,
      model: reportedModel,
      message: terminalMessage,
    };
    parseToolChatResponse(response);
    yield { type: 'response', response };
  }

  readonly streamPrompt: NonNullable<ProviderAdapter['streamPrompt']> = (
    input: PromptInput,
  ): AsyncIterable<PromptStreamEvent> => {
    validatePrompt(input);
    const format =
      input.responseSchema === undefined
        ? undefined
        : prepareSchema(input.responseSchema);
    const normalizedInput: PromptInput = {
      ...input,
      ...(format === undefined ? {} : { responseSchema: format }),
    };
    const credential = this.credential();
    const headers = {
      'content-type': 'application/json',
      ...(this.authorizationHeaders(credential) ?? {}),
    };
    const source = this.streamRaw(normalizedInput, headers, format);
    return finalizeStream(source, normalizedInput, credential);
  };

  private async *streamRaw(
    input: PromptInput,
    headers: Record<string, string>,
    format: Record<string, unknown> | undefined,
  ): AsyncGenerator<PromptStreamEvent> {
    const events = requestEvents({
      url: this.endpoint('/api/chat'),
      method: 'POST',
      headers,
      body: {
        model: this.model,
        messages: [{ role: 'user', content: input.prompt }],
        stream: true,
        options: { num_predict: this.maxOutputTokens },
        ...(format === undefined ? {} : { format }),
      },
      timeoutMs: input.timeoutMs,
      approved: input.approved,
      signal: input.signal,
      format: 'ndjson',
    });
    const chunks: string[] = [];
    let reportedModel: string | undefined;
    for await (const event of events) {
      const frame = parseStreamFrame(event.data);
      if (reportedModel === undefined) reportedModel = frame.model;
      else if (frame.model !== reportedModel)
        throw invalidResponse('the reported model changed during streaming.');
      chunks.push(frame.content);
      if (frame.done) {
        const terminal = event.data as Record<string, unknown>;
        const result = parseChatResponse({
          ...terminal,
          model: reportedModel,
          message: { role: 'assistant', content: chunks.join('') },
          done: true,
        });
        yield { type: 'complete', result };
        return;
      }
      if (frame.content.length > 0)
        yield {
          type: 'text-delta',
          text: frame.content,
          provisional: true,
        };
    }
    throw invalidResponse('the stream ended before a done=true frame.');
  }

  private endpoint(pathname: string): string {
    return new URL(
      pathname.slice(1),
      `${this.baseUrl.replace(/\/$/, '')}/`,
    ).toString();
  }

  private credential(): string | undefined {
    if (!this.apiKeyEnv) return undefined;
    const credential = getCredential(this.apiKeyEnv);
    if (!credential)
      throw new ProviderError(
        'authentication',
        `The configured Ollama API credential is missing from ${this.apiKeyEnv}.`,
      );
    return credential;
  }

  private authorizationHeaders(
    credential = this.credential(),
  ): Record<string, string> | undefined {
    return credential ? { authorization: `Bearer ${credential}` } : undefined;
  }

  private authenticationState(): AdapterHealth['authentication'] {
    if (!this.apiKeyEnv) return 'not-required';
    return getCredential(this.apiKeyEnv) ? 'configured' : 'missing';
  }
}
