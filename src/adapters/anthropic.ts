import { ProviderError } from './errors.js';
import {
  getCredential,
  requestJson,
  validateBaseUrl,
  validatePrompt,
  validateProviderOptions,
} from './http.js';
import { finishPrompt, finalizeStream, prepareSchema } from './output.js';
import { requestEvents } from './streaming.js';
import { anthropicToolCodec } from './hosted-tools.js';
import { createToolSession as createSharedToolSession } from './tools.js';
import type {
  AdapterCapabilities,
  AdapterHealth,
  PromptInput,
  PromptResult,
  PromptStreamEvent,
  ProviderAdapter,
  ProviderOptions,
  RequestOptions,
  ToolSession,
  ToolSessionInput,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY';
const ANTHROPIC_VERSION = '2023-06-01';
const VERSION = '1.0.0';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new ProviderError(
    'invalid-response',
    'Anthropic returned an invalid response.',
  );
}

function invalidStreamResponse(): never {
  throw new ProviderError(
    'invalid-response',
    'Anthropic returned an invalid stream response.',
  );
}

function failedStream(): never {
  throw new ProviderError(
    'unavailable',
    'Anthropic stream failed. Provider details omitted.',
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function parseUsage(value: unknown): PromptResult['usage'] {
  if (!isObject(value)) return { status: 'unavailable' };
  const rawInputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (!isTokenCount(rawInputTokens) || !isTokenCount(outputTokens)) {
    return { status: 'unavailable' };
  }

  const cachedInputTokens = value.cache_read_input_tokens;
  const cacheCreationInputTokens = value.cache_creation_input_tokens;
  if (
    (cachedInputTokens !== undefined && !isTokenCount(cachedInputTokens)) ||
    (cacheCreationInputTokens !== undefined &&
      !isTokenCount(cacheCreationInputTokens))
  ) {
    return { status: 'unavailable' };
  }
  const inputTokens =
    rawInputTokens + (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
  if (!Number.isSafeInteger(inputTokens)) return { status: 'unavailable' };

  const usage: Extract<PromptResult['usage'], { status: 'available' }> = {
    status: 'available',
    inputTokens,
    outputTokens,
  };
  if (cachedInputTokens !== undefined)
    usage.cachedInputTokens = cachedInputTokens;
  if (cacheCreationInputTokens !== undefined) {
    usage.cacheCreationInputTokens = cacheCreationInputTokens;
  }
  return usage;
}

type StreamBlock =
  { type: 'text'; text: string } | { type: 'thinking' | 'redacted_thinking' };

function parseResponse(value: unknown): PromptResult {
  if (
    !isObject(value) ||
    value.type !== 'message' ||
    !isNonEmptyString(value.model) ||
    !Array.isArray(value.content) ||
    !isNonEmptyString(value.stop_reason)
  ) {
    return invalidResponse();
  }

  let text = '';
  for (const block of value.content) {
    if (!isObject(block) || !isNonEmptyString(block.type))
      return invalidResponse();
    if (block.type !== 'text' || typeof block.text !== 'string')
      return invalidResponse();
    text += block.text;
  }

  let finishReason: PromptResult['finishReason'];
  if (
    value.stop_reason === 'end_turn' ||
    value.stop_reason === 'stop_sequence'
  ) {
    if (text.length === 0) return invalidResponse();
    finishReason = 'completed';
  } else if (value.stop_reason === 'max_tokens') {
    finishReason = 'length';
  } else if (value.stop_reason === 'refusal') {
    finishReason = 'refusal';
  } else {
    return invalidResponse();
  }

  return {
    text,
    model: value.model,
    finishReason,
    usage: parseUsage(value.usage),
  };
}

function modelListIsValid(value: unknown): boolean {
  return (
    isObject(value) &&
    Array.isArray(value.data) &&
    value.data.every((model) => isObject(model) && isNonEmptyString(model.id))
  );
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic';
  readonly version = VERSION;
  readonly kind = 'model-provider' as const;

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKeyEnv: string;
  private readonly maxOutputTokens: number;

  constructor(options: ProviderOptions) {
    const validated = validateProviderOptions(
      options,
      DEFAULT_BASE_URL,
      DEFAULT_API_KEY_ENV,
    );
    this.model = validated.model;
    this.baseUrl = validateBaseUrl(validated.baseUrl);
    this.apiKeyEnv = validated.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
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
    if (getCredential(this.apiKeyEnv) === undefined) {
      return {
        status: 'unavailable',
        authentication: 'missing',
        connection: 'not-checked',
        detail: `Credentials are missing from ${this.apiKeyEnv}; no connection was attempted.`,
      };
    }
    return {
      status: 'available',
      authentication: 'configured',
      connection: 'not-checked',
      detail:
        'Credentials are configured. Not connected; configuration readiness only.',
    };
  }

  async checkConnection(input: RequestOptions): Promise<AdapterHealth> {
    const credential = getCredential(this.apiKeyEnv);
    if (credential === undefined) {
      throw new ProviderError(
        'authentication',
        'Anthropic credentials are not configured.',
      );
    }
    const response = await requestJson({
      url: `${this.baseUrl}/models`,
      method: 'GET',
      headers: {
        'x-api-key': credential,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      timeoutMs: input.timeoutMs,
      approved: input.approved,
      signal: input.signal,
    });
    if (!modelListIsValid(response)) return invalidResponse();
    return {
      status: 'available',
      authentication: 'configured',
      connection: 'verified',
      detail:
        'The Anthropic models endpoint is accessible; this does not guarantee inference or model access.',
    };
  }

  async submitPrompt(input: PromptInput): Promise<PromptResult> {
    validatePrompt(input);
    const schema =
      input.responseSchema === undefined
        ? undefined
        : prepareSchema(input.responseSchema);
    const normalizedInput = {
      ...input,
      ...(schema === undefined ? {} : { responseSchema: schema }),
    };
    const credential = getCredential(this.apiKeyEnv);
    if (credential === undefined) {
      throw new ProviderError(
        'authentication',
        'Anthropic credentials are not configured.',
      );
    }
    const response = await requestJson({
      url: `${this.baseUrl}/messages`,
      method: 'POST',
      headers: {
        'x-api-key': credential,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: {
        model: this.model,
        messages: [{ role: 'user', content: input.prompt }],
        max_tokens: this.maxOutputTokens,
        stream: false,
        ...(schema === undefined
          ? {}
          : { output_config: { format: { type: 'json_schema', schema } } }),
      },
      timeoutMs: input.timeoutMs,
      approved: input.approved,
      signal: input.signal,
    });
    return finishPrompt(parseResponse(response), normalizedInput, credential);
  }

  createToolSession(input: ToolSessionInput): ToolSession {
    const credential = getCredential(this.apiKeyEnv);
    if (credential === undefined) {
      throw new ProviderError(
        'authentication',
        'Anthropic credentials are not configured.',
      );
    }
    return createSharedToolSession(
      input,
      anthropicToolCodec({
        model: this.model,
        baseUrl: this.baseUrl,
        credential,
        maxOutputTokens: this.maxOutputTokens,
      }),
      credential,
    );
  }

  streamPrompt(input: PromptInput): AsyncIterable<PromptStreamEvent> {
    validatePrompt(input);
    const schema =
      input.responseSchema === undefined
        ? undefined
        : prepareSchema(input.responseSchema);
    const normalizedInput = {
      ...input,
      ...(schema === undefined ? {} : { responseSchema: schema }),
    };
    const credential = getCredential(this.apiKeyEnv);
    if (credential === undefined) {
      throw new ProviderError(
        'authentication',
        'Anthropic credentials are not configured.',
      );
    }
    return finalizeStream(
      this.streamNative(normalizedInput, credential, schema),
      normalizedInput,
      credential,
    );
  }

  private async *streamNative(
    input: PromptInput,
    credential: string,
    schema: Record<string, unknown> | undefined,
  ): AsyncGenerator<PromptStreamEvent> {
    let started = false;
    let model = '';
    let inputUsage: unknown;
    let stopReason: string | undefined;
    let outputTokens: unknown;
    const blocks: StreamBlock[] = [];
    let nextBlockIndex = 0;
    let activeIndex: number | undefined;
    let messageDeltaSeen = false;

    for await (const event of requestEvents({
      url: `${this.baseUrl}/messages`,
      method: 'POST',
      headers: {
        'x-api-key': credential,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: {
        model: this.model,
        messages: [{ role: 'user', content: input.prompt }],
        max_tokens: this.maxOutputTokens,
        stream: true,
        ...(schema === undefined
          ? {}
          : { output_config: { format: { type: 'json_schema', schema } } }),
      },
      timeoutMs: input.timeoutMs,
      approved: input.approved,
      signal: input.signal,
      format: 'sse',
    })) {
      if (!isObject(event.data) || !isNonEmptyString(event.data.type)) {
        if (event.event === 'error') failedStream();
        return invalidStreamResponse();
      }
      const data = event.data;
      const type = data.type;
      if (type === 'ping') continue;
      if (type === 'error') failedStream();

      if (type === 'message_start') {
        if (started || !isObject(data.message)) return invalidStreamResponse();
        if (
          data.message.type !== 'message' ||
          !isNonEmptyString(data.message.model) ||
          !Array.isArray(data.message.content) ||
          data.message.content.length !== 0
        ) {
          return invalidStreamResponse();
        }
        started = true;
        model = data.message.model;
        inputUsage = data.message.usage;
        continue;
      }

      if (type === 'content_block_start') {
        if (
          !started ||
          messageDeltaSeen ||
          activeIndex !== undefined ||
          !Number.isSafeInteger(data.index) ||
          data.index !== nextBlockIndex ||
          !isObject(data.content_block) ||
          !isNonEmptyString(data.content_block.type)
        ) {
          return invalidStreamResponse();
        }
        const index = data.index as number;
        const nativeBlock = data.content_block;
        if (nativeBlock.type === 'text') {
          if (typeof nativeBlock.text !== 'string')
            return invalidStreamResponse();
          const block: StreamBlock = { type: 'text', text: nativeBlock.text };
          blocks.push(block);
          activeIndex = index;
          if (block.text.length > 0) {
            yield { type: 'text-delta', text: block.text, provisional: true };
          }
        } else if (
          nativeBlock.type === 'thinking' ||
          nativeBlock.type === 'redacted_thinking'
        ) {
          blocks.push({ type: nativeBlock.type });
          activeIndex = index;
        } else {
          // Tool use and all non-text output blocks remain unsupported.
          return invalidStreamResponse();
        }
        continue;
      }

      if (type === 'content_block_delta') {
        if (
          !started ||
          messageDeltaSeen ||
          activeIndex === undefined ||
          data.index !== activeIndex ||
          !isObject(data.delta) ||
          !isNonEmptyString(data.delta.type)
        ) {
          return invalidStreamResponse();
        }
        const block = blocks[activeIndex];
        const delta = data.delta;
        if (block?.type === 'text' && delta.type === 'text_delta') {
          if (typeof delta.text !== 'string') return invalidStreamResponse();
          block.text += delta.text;
          if (delta.text.length > 0) {
            yield { type: 'text-delta', text: delta.text, provisional: true };
          }
        } else if (
          block?.type === 'thinking' &&
          (delta.type === 'thinking_delta' || delta.type === 'signature_delta')
        ) {
          if (
            typeof delta.thinking !== 'string' &&
            typeof delta.signature !== 'string'
          )
            return invalidStreamResponse();
        } else {
          return invalidStreamResponse();
        }
        continue;
      }

      if (type === 'content_block_stop') {
        if (
          !started ||
          messageDeltaSeen ||
          activeIndex === undefined ||
          data.index !== activeIndex
        ) {
          return invalidStreamResponse();
        }
        activeIndex = undefined;
        nextBlockIndex += 1;
        continue;
      }

      if (type === 'message_delta') {
        if (!started || activeIndex !== undefined || !isObject(data.delta))
          return invalidStreamResponse();
        messageDeltaSeen = true;
        if (
          data.delta.stop_reason !== undefined &&
          data.delta.stop_reason !== null
        ) {
          if (!isNonEmptyString(data.delta.stop_reason))
            return invalidStreamResponse();
          stopReason = data.delta.stop_reason;
        }
        if (isObject(data.usage) && data.usage.output_tokens !== undefined) {
          outputTokens = data.usage.output_tokens;
        }
        continue;
      }

      if (type === 'message_stop') {
        if (
          !started ||
          activeIndex !== undefined ||
          !messageDeltaSeen ||
          stopReason === undefined
        )
          return invalidStreamResponse();
        const usage = isObject(inputUsage)
          ? { ...inputUsage, output_tokens: outputTokens }
          : inputUsage;
        const result = parseResponse({
          type: 'message',
          model,
          content: blocks
            .filter(
              (block): block is Extract<StreamBlock, { type: 'text' }> =>
                block.type === 'text',
            )
            .map(({ text }) => ({ type: 'text', text })),
          stop_reason: stopReason,
          usage,
        });
        yield { type: 'complete', result };
        return;
      }

      return invalidStreamResponse();
    }
  }
}
