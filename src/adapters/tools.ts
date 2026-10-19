import { ProviderError } from './errors.js';
import {
  prepareSchema,
  validateSchemaData,
  finalizeStream,
  finishPrompt,
} from './output.js';
import { validatePrompt } from './http.js';
import { prepareResultSchema, validateToolResult } from './tool-results.js';
import {
  hasSensitivePropertyNames,
  hasSensitiveSerializedPrimitiveValues,
  redact,
  redactValue,
} from '../shared/safety.js';
import type {
  RequestOptions,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolSession,
  ToolSessionInput,
  ToolTurn,
  ToolStreamEvent,
  PromptStreamEvent,
  ToolRequestOptions,
} from './types.js';
export interface ToolCodec {
  initial(prompt: string): unknown[];
  request(
    history: unknown[],
    tools: ToolDefinition[],
    options: ToolRequestOptions,
  ): Promise<unknown>;
  stream?(
    history: unknown[],
    tools: ToolDefinition[],
    options: ToolRequestOptions,
  ): AsyncIterable<NativeToolStreamEvent>;
  parse(response: unknown): { turn: ToolTurn; continuation: unknown[] };
  append(
    history: unknown[],
    continuation: unknown[],
    results: ToolResult[],
    calls: ToolCall[],
  ): unknown[];
}
export type NativeToolStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'response'; response: unknown };
function invalid(
  message = 'Invalid tool conversation data. Details omitted.',
): never {
  throw new ProviderError('validation', message);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Reject non-JSON values and excessive nesting before serialization. */
export function cloneToolJson<T>(value: T, maxBytes = 65536): T {
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 50000 || depth > 32)
      invalid('Tool data exceeds structural limits.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null) invalid();
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      invalid();
    for (const child of Object.values(item)) visit(child, depth + 1);
  }
  visit(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes)
    invalid('Tool data exceeds byte limit.');
  return JSON.parse(text) as T;
}
export function prepareTools(value: unknown): ToolDefinition[] {
  const tools = cloneToolJson(value, 262144);
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 16)
    invalid('Declare between one and sixteen client tools.');
  const names = new Set<string>();
  return tools.map((tool: unknown) => {
    if (
      !record(tool) ||
      Object.keys(tool).some(
        (key) =>
          !['name', 'description', 'parameters', 'resultSchema'].includes(key),
      ) ||
      typeof tool.name !== 'string' ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) ||
      ['constructor', 'prototype'].includes(tool.name) ||
      names.has(tool.name) ||
      typeof tool.description !== 'string' ||
      tool.description.length < 1 ||
      tool.description.length > 2048
    )
      invalid('Invalid or duplicate client tool definition.');
    names.add(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      parameters: prepareSchema(tool.parameters),
      ...(tool.resultSchema === undefined
        ? {}
        : { resultSchema: prepareResultSchema(tool.resultSchema) }),
    };
  });
}
export function validateToolCalls(
  tools: ToolDefinition[],
  value: unknown,
  credential?: string,
): ToolCall[] {
  const calls = cloneToolJson(value, 262144);
  if (!Array.isArray(calls) || calls.length > 16)
    invalid('Tool call count exceeds limit.');
  const ids = new Set<string>();
  return calls.map((call: unknown) => {
    if (
      !record(call) ||
      Object.keys(call).some(
        (key) => !['id', 'name', 'arguments'].includes(key),
      ) ||
      typeof call.id !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,200}$/.test(call.id) ||
      ids.has(call.id) ||
      typeof call.name !== 'string' ||
      !record(call.arguments)
    )
      invalid('Invalid or duplicate tool call.');
    ids.add(call.id);
    const definition = tools.find((tool) => tool.name === call.name);
    if (
      !definition ||
      !validateSchemaData(call.arguments, definition.parameters)
    )
      invalid('Tool call does not match a registered function schema.');
    const normalized = {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    };
    const sensitiveValues = credential ? [credential] : [];
    if (hasSensitivePropertyNames(normalized, sensitiveValues))
      invalid(
        'Tool call contains sensitive property names; execution withheld.',
      );
    const safe = redactValue(normalized, sensitiveValues);
    if (
      JSON.stringify(safe) !== JSON.stringify(normalized) ||
      hasSensitiveSerializedPrimitiveValues(safe, sensitiveValues)
    )
      invalid('Tool call contains sensitive data; execution withheld.');
    return normalized;
  });
}
function resultsFor(
  value: unknown,
  pending: ToolCall[],
  tools: ToolDefinition[],
  credential?: string,
): ToolResult[] {
  if (value === undefined && pending.length === 0) return [];
  const results = cloneToolJson(value, 262144);
  if (
    !Array.isArray(results) ||
    results.length !== pending.length ||
    !pending.length
  )
    invalid('Results must match every pending tool call exactly once.');
  const ids = new Set<string>();
  for (const result of results) {
    if (
      !record(result) ||
      Object.keys(result).some(
        (key) => !['callId', 'output', 'isError'].includes(key),
      ) ||
      typeof result.callId !== 'string' ||
      typeof result.output !== 'string' ||
      Buffer.byteLength(result.output) > 65536 ||
      (result.isError !== undefined && typeof result.isError !== 'boolean') ||
      ids.has(result.callId) ||
      !pending.some((call) => call.id === result.callId)
    )
      invalid('Invalid or uncorrelated tool result.');
    ids.add(result.callId);
  }
  // Providers such as Ollama correlate repeated function names by message order.
  return pending.map((call) => {
    const result = results.find(
      (item) => item.callId === call.id,
    )! as ToolResult;
    return validateToolResult(
      result,
      tools.find((tool) => tool.name === call.name)!.resultSchema,
      credential ? [credential] : [],
    );
  });
}
/** Native state is private, bounded and discarded with the in-memory session. No tool is executed here. */
export function createToolSession(
  input: ToolSessionInput,
  codec: ToolCodec,
  credential?: string,
): ToolSession {
  validatePrompt({ ...input, approved: false, timeoutMs: 1 });
  const prompt = input.prompt;
  const responseSchema =
    input.responseSchema === undefined
      ? undefined
      : prepareSchema(input.responseSchema);
  const tools = prepareTools(input.tools);
  // Result contracts are local policy, absent even from the codec-facing declarations.
  const wireTools = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const maxTurns = input.maxTurns ?? 6;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 10)
    invalid('Tool sessions allow one to ten network turns.');
  let history = cloneToolJson(codec.initial(prompt), 1048576);
  let continuation: unknown[] = [];
  let pending: ToolCall[] = [];
  let turns = 0,
    busy = false,
    closed = false;
  type Options = RequestOptions & { results?: ToolResult[] };
  function capture(options: Options): Options {
    return {
      approved: options.approved,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      ...(options.results === undefined
        ? {}
        : { results: cloneToolJson(options.results, 262144) }),
    };
  }
  function begin(options: Options) {
    if (options.approved !== true)
      throw new ProviderError(
        'policy',
        'Explicit network approval is required for each tool turn.',
      );
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 300000
    )
      invalid('Invalid tool request timeout.');
    if (options.signal?.aborted)
      throw new ProviderError('cancelled', 'Tool conversation cancelled.');
    if (closed || busy)
      throw new ProviderError(
        'policy',
        'Tool session is closed or a request is already in flight.',
      );
    if (turns >= maxTurns)
      throw new ProviderError(
        'policy',
        'Tool conversation turn limit reached.',
      );
    const results = resultsFor(options.results, pending, tools, credential);
    const nextHistory = pending.length
      ? cloneToolJson(
          codec.append(history, continuation, results, pending),
          1048576,
        )
      : history;
    busy = true;
    turns++;
    return {
      nextHistory,
      request: {
        approved: true,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        ...(responseSchema === undefined
          ? {}
          : { responseSchema: cloneToolJson(responseSchema) }),
      },
    };
  }
  function normalize(response: unknown, signal?: AbortSignal) {
    if (signal?.aborted)
      throw new ProviderError('cancelled', 'Tool conversation cancelled.');
    const parsed = codec.parse(response);
    const turn = parsed.turn;
    const calls = validateToolCalls(tools, turn.calls, credential);
    if (calls.length && turns >= maxTurns)
      throw new ProviderError(
        'policy',
        'Tool conversation turn limit reached before tool execution.',
      );
    if (
      !['completed', 'length', 'refusal', 'tool-calls'].includes(
        turn.finishReason,
      ) ||
      calls.length > 0 !== (turn.finishReason === 'tool-calls') ||
      typeof turn.text !== 'string' ||
      typeof turn.model !== 'string' ||
      !turn.model.length ||
      (!calls.length && turn.finishReason === 'completed' && !turn.text.length)
    )
      invalid('Invalid terminal tool response.');
    let normalized: ToolTurn = {
      text: redact(turn.text, credential ? [credential] : []),
      model: redact(turn.model, credential ? [credential] : []),
      finishReason: turn.finishReason,
      usage: turn.usage,
      calls,
    };
    if (responseSchema !== undefined) {
      if (calls.length) {
        normalized.text = '';
        normalized.structured = { status: 'pending', reason: 'tool-calls' };
      } else {
        if (turn.finishReason === 'tool-calls') invalid();
        normalized = {
          ...finishPrompt(
            {
              text: turn.text,
              model: turn.model,
              finishReason: turn.finishReason,
              usage: turn.usage,
            },
            { prompt, approved: false, timeoutMs: 1, responseSchema },
            credential,
          ),
          calls,
        };
      }
    }
    return {
      continuation: cloneToolJson(parsed.continuation, 1048576),
      turn: cloneToolJson(normalized, 1048576),
      rawText: turn.text,
    };
  }
  function commit(
    accepted: ReturnType<typeof normalize>,
    nextHistory: unknown[],
  ) {
    continuation = accepted.continuation;
    pending = cloneToolJson(accepted.turn.calls, 262144);
    history = nextHistory;
    closed = pending.length === 0;
  }
  const session: ToolSession = {
    async next(options) {
      const { nextHistory, request } = begin(capture(options));
      try {
        const response = await codec.request(
          cloneToolJson(nextHistory, 1048576),
          cloneToolJson(wireTools, 262144),
          request,
        );
        const accepted = normalize(response, request.signal);
        commit(accepted, nextHistory);
        return accepted.turn;
      } catch (error) {
        closed = true;
        throw error;
      } finally {
        busy = false;
      }
    },
  };
  if (codec.stream)
    session.stream = (options) => {
      // Capture before lazy iteration; mutating a caller's request cannot grant approval.
      const snapshot = capture(options);
      return stream(snapshot);
    };
  async function* stream(options: Options): AsyncGenerator<ToolStreamEvent> {
    const { nextHistory, request } = begin(options);
    let accepted: ReturnType<typeof normalize> | undefined;
    let completed = false;
    async function* native(): AsyncGenerator<PromptStreamEvent> {
      let received = false;
      let response: unknown;
      for await (const event of codec.stream!(
        cloneToolJson(nextHistory, 1048576),
        cloneToolJson(wireTools, 262144),
        request,
      )) {
        if (received)
          throw new ProviderError(
            'invalid-response',
            'Tool stream continued after its terminal response.',
          );
        if (event.type === 'text-delta') {
          if (typeof event.text !== 'string') invalid();
          yield { type: 'text-delta', text: event.text, provisional: true };
        } else if (event.type === 'response') {
          received = true;
          response = event.response;
        } else invalid();
      }
      if (!received)
        throw new ProviderError(
          'invalid-response',
          'Tool stream ended without a terminal response.',
        );
      accepted = normalize(response, request.signal);
      yield {
        type: 'complete',
        result: {
          text: accepted.rawText,
          model: accepted.turn.model,
          usage: accepted.turn.usage,
          finishReason:
            accepted.turn.finishReason === 'tool-calls'
              ? 'completed'
              : accepted.turn.finishReason,
        },
      };
    }
    try {
      for await (const event of finalizeStream(
        native(),
        {
          prompt,
          approved: request.approved,
          timeoutMs: request.timeoutMs,
          signal: request.signal,
        },
        credential,
      )) {
        if (event.type === 'text-delta') {
          if (responseSchema === undefined) yield event;
        } else {
          if (!accepted) invalid();
          if (request.signal?.aborted)
            throw new ProviderError(
              'cancelled',
              'Tool conversation cancelled.',
            );
          commit(accepted, nextHistory);
          completed = true;
          yield {
            type: 'complete',
            turn:
              responseSchema === undefined
                ? {
                    ...accepted.turn,
                    text: event.result.text,
                    model: event.result.model,
                  }
                : accepted.turn,
          };
        }
      }
    } finally {
      if (!completed) closed = true;
      busy = false;
    }
  }
  return session;
}
