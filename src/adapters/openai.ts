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
import { openAIToolCodec } from './hosted-tools.js';
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

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';
const VERSION = '1.0.0';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new ProviderError(
    'invalid-response',
    'OpenAI returned an invalid response.',
  );
}

function invalidStreamResponse(): never {
  throw new ProviderError(
    'invalid-response',
    'OpenAI returned an invalid stream response.',
  );
}

function failedStream(): never {
  throw new ProviderError(
    'unavailable',
    'OpenAI stream failed. Provider details omitted.',
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
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) {
    return { status: 'unavailable' };
  }

  const usage: Extract<PromptResult['usage'], { status: 'available' }> = {
    status: 'available',
    inputTokens,
    outputTokens,
  };
  if (value.input_tokens_details !== undefined) {
    if (!isObject(value.input_tokens_details)) return { status: 'unavailable' };
    const cachedTokens = value.input_tokens_details.cached_tokens;
    if (cachedTokens !== undefined) {
      if (!isTokenCount(cachedTokens)) return { status: 'unavailable' };
      usage.cachedInputTokens = cachedTokens;
    }
  }
  return usage;
}

function parseResponse(value: unknown): PromptResult {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.status) ||
    !isNonEmptyString(value.model) ||
    !Array.isArray(value.output)
  ) {
    return invalidResponse();
  }

  let text = '';
  let refusalText = '';
  for (const item of value.output) {
    if (!isObject(item) || !isNonEmptyString(item.type))
      return invalidResponse();
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || !Array.isArray(item.content))
      return invalidResponse();
    for (const block of item.content) {
      if (!isObject(block) || !isNonEmptyString(block.type))
        return invalidResponse();
      if (block.type === 'output_text') {
        if (typeof block.text !== 'string') return invalidResponse();
        text += block.text;
      } else if (block.type === 'refusal') {
        if (typeof block.refusal !== 'string') return invalidResponse();
        refusalText += block.refusal;
      } else {
        return invalidResponse();
      }
    }
  }

  let finishReason: PromptResult['finishReason'];
  if (refusalText.length > 0) {
    text = refusalText;
    finishReason = 'refusal';
  } else if (value.status === 'completed') {
    if (text.length === 0) return invalidResponse();
    finishReason = 'completed';
  } else if (
    value.status === 'incomplete' &&
    isObject(value.incomplete_details) &&
    value.incomplete_details.reason === 'max_output_tokens'
  ) {
    finishReason = 'length';
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

export class OpenAIAdapter implements ProviderAdapter {
  readonly id = 'openai';
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
        'OpenAI credentials are not configured.',
      );
    }
    const response = await requestJson({
      url: `${this.baseUrl}/models`,
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}` },
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
        'The OpenAI models endpoint is accessible; this does not guarantee inference or model access.',
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
        'OpenAI credentials are not configured.',
      );
    }
    const response = await requestJson({
      url: `${this.baseUrl}/responses`,
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}` },
      body: {
        model: this.model,
        input: input.prompt,
        max_output_tokens: this.maxOutputTokens,
        store: false,
        stream: false,
        ...(schema === undefined
          ? {}
          : {
              text: {
                format: {
                  type: 'json_schema',
                  name: 'agentforge_output',
                  strict: true,
                  schema,
                },
              },
            }),
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
        'OpenAI credentials are not configured.',
      );
    }
    return createSharedToolSession(
      input,
      openAIToolCodec({
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
        'OpenAI credentials are not configured.',
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
    let accumulatedText = '';
    for await (const event of requestEvents({
      url: `${this.baseUrl}/responses`,
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}` },
      body: {
        model: this.model,
        input: input.prompt,
        max_output_tokens: this.maxOutputTokens,
        store: false,
        stream: true,
        ...(schema === undefined
          ? {}
          : {
              text: {
                format: {
                  type: 'json_schema',
                  name: 'agentforge_output',
                  strict: true,
                  schema,
                },
              },
            }),
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
      const type = data.type as string;
      if (
        type === 'response.output_text.delta' ||
        type === 'response.refusal.delta'
      ) {
        if (typeof data.delta !== 'string') return invalidStreamResponse();
        if (data.delta.length > 0) {
          accumulatedText += data.delta;
          yield { type: 'text-delta', text: data.delta, provisional: true };
        }
        continue;
      }
      if (type === 'response.completed' || type === 'response.incomplete') {
        if (
          !isObject(data.response) ||
          data.response.status !==
            (type === 'response.completed' ? 'completed' : 'incomplete')
        )
          return invalidStreamResponse();
        const result = parseResponse(data.response);
        if (!result.text.startsWith(accumulatedText))
          return invalidStreamResponse();
        yield { type: 'complete', result };
        return;
      }
      if (type === 'error' || type === 'response.failed') failedStream();
      if (type === 'response.cancelled') {
        throw new ProviderError('cancelled', 'OpenAI stream was cancelled.');
      }

      if (
        type === 'response.output_item.added' ||
        type === 'response.output_item.done'
      ) {
        if (!isObject(data.item) || !isNonEmptyString(data.item.type))
          return invalidStreamResponse();
        if (data.item.type !== 'message' && data.item.type !== 'reasoning')
          return invalidStreamResponse();
        continue;
      }
      if (
        type === 'response.content_part.added' ||
        type === 'response.content_part.done'
      ) {
        if (!isObject(data.part) || !isNonEmptyString(data.part.type))
          return invalidStreamResponse();
        if (
          data.part.type !== 'output_text' &&
          data.part.type !== 'refusal' &&
          data.part.type !== 'reasoning_text' &&
          data.part.type !== 'summary_text'
        )
          return invalidStreamResponse();
        continue;
      }
      if (
        type === 'response.created' ||
        type === 'response.in_progress' ||
        type === 'response.output_text.done' ||
        type === 'response.refusal.done' ||
        type.startsWith('response.reasoning_')
      ) {
        continue;
      }
      // Tool-call and future event types fail closed; no streamed tool is accepted or run.
      return invalidStreamResponse();
    }
  }
}
