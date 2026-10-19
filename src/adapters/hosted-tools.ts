import { ProviderError } from './errors.js';
import { requestJson } from './http.js';
import {
  streamAnthropicToolResponse,
  streamOpenAIToolResponse,
} from './hosted-tool-streams.js';
import type {
  PromptResult,
  ToolRequestOptions,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolTurn,
} from './types.js';
import type { ToolCodec } from './tools.js';

type JsonObject = Record<string, unknown>;

interface HostedCodecOptions {
  model: string;
  baseUrl: string;
  credential: string;
  maxOutputTokens: number;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function invalidResponse(provider: 'OpenAI' | 'Anthropic'): never {
  throw new ProviderError(
    'invalid-response',
    `${provider} returned an invalid tool response.`,
  );
}

function parseOpenAIUsage(value: unknown): PromptResult['usage'] {
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

function parseAnthropicUsage(value: unknown): PromptResult['usage'] {
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

function parseOpenAIResponse(value: unknown): {
  turn: ToolTurn;
  continuation: unknown[];
} {
  if (
    !isObject(value) ||
    !isNonEmptyString(value.status) ||
    !isNonEmptyString(value.model) ||
    !Array.isArray(value.output)
  ) {
    return invalidResponse('OpenAI');
  }

  let text = '';
  let refusalText = '';
  const calls: ToolCall[] = [];
  const continuation: unknown[] = [];

  for (const item of value.output) {
    if (!isObject(item) || !isNonEmptyString(item.type))
      return invalidResponse('OpenAI');

    if (item.type === 'reasoning') {
      if (
        !isNonEmptyString(item.id) ||
        !Array.isArray(item.summary) ||
        item.summary.some(
          (part) =>
            !isObject(part) ||
            part.type !== 'summary_text' ||
            typeof part.text !== 'string',
        ) ||
        (item.status !== undefined && item.status !== 'completed') ||
        (item.encrypted_content !== undefined &&
          item.encrypted_content !== null &&
          typeof item.encrypted_content !== 'string') ||
        (item.content !== undefined &&
          (!Array.isArray(item.content) ||
            item.content.some(
              (part) =>
                !isObject(part) ||
                part.type !== 'reasoning_text' ||
                typeof part.text !== 'string',
            )))
      )
        return invalidResponse('OpenAI');
      continuation.push(item);
      continue;
    }

    if (item.type === 'message') {
      if (
        !isNonEmptyString(item.id) ||
        item.role !== 'assistant' ||
        !['completed', 'incomplete'].includes(String(item.status)) ||
        (value.status === 'completed' && item.status !== 'completed') ||
        !Array.isArray(item.content)
      )
        return invalidResponse('OpenAI');
      for (const block of item.content) {
        if (!isObject(block) || !isNonEmptyString(block.type))
          return invalidResponse('OpenAI');
        if (block.type === 'output_text') {
          if (typeof block.text !== 'string') return invalidResponse('OpenAI');
          text += block.text;
        } else if (block.type === 'refusal') {
          if (typeof block.refusal !== 'string')
            return invalidResponse('OpenAI');
          refusalText += block.refusal;
        } else {
          return invalidResponse('OpenAI');
        }
      }
      continuation.push(item);
      continue;
    }

    if (item.type === 'function_call') {
      if (
        !isNonEmptyString(item.call_id) ||
        !isNonEmptyString(item.name) ||
        typeof item.arguments !== 'string' ||
        (item.status !== undefined && item.status !== 'completed')
      ) {
        return invalidResponse('OpenAI');
      }
      let args: unknown;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        return invalidResponse('OpenAI');
      }
      if (!isObject(args)) return invalidResponse('OpenAI');
      calls.push({ id: item.call_id, name: item.name, arguments: args });
      continuation.push(item);
      continue;
    }

    // Native server tools and unknown output types are not client functions.
    return invalidResponse('OpenAI');
  }

  if (calls.length > 0) {
    if (value.status !== 'completed' || refusalText.length > 0) {
      return invalidResponse('OpenAI');
    }
    return {
      turn: {
        text,
        model: value.model,
        finishReason: 'tool-calls',
        usage: parseOpenAIUsage(value.usage),
        calls,
      },
      continuation,
    };
  }

  let finishReason: ToolTurn['finishReason'];
  if (refusalText.length > 0) {
    text = refusalText;
    finishReason = 'refusal';
  } else if (value.status === 'completed') {
    if (text.length === 0) return invalidResponse('OpenAI');
    finishReason = 'completed';
  } else if (
    value.status === 'incomplete' &&
    isObject(value.incomplete_details) &&
    value.incomplete_details.reason === 'max_output_tokens'
  ) {
    finishReason = 'length';
  } else {
    return invalidResponse('OpenAI');
  }

  return {
    turn: {
      text,
      model: value.model,
      finishReason,
      usage: parseOpenAIUsage(value.usage),
      calls: [],
    },
    continuation,
  };
}

function parseAnthropicResponse(value: unknown): {
  turn: ToolTurn;
  continuation: unknown[];
} {
  if (
    !isObject(value) ||
    value.type !== 'message' ||
    value.role !== 'assistant' ||
    !isNonEmptyString(value.model) ||
    !Array.isArray(value.content) ||
    !isNonEmptyString(value.stop_reason)
  ) {
    return invalidResponse('Anthropic');
  }

  let text = '';
  const calls: ToolCall[] = [];
  for (const block of value.content) {
    if (!isObject(block) || !isNonEmptyString(block.type))
      return invalidResponse('Anthropic');
    if (block.type === 'text') {
      if (typeof block.text !== 'string') return invalidResponse('Anthropic');
      text += block.text;
    } else if (block.type === 'thinking') {
      if (
        typeof block.thinking !== 'string' ||
        !isNonEmptyString(block.signature)
      ) {
        return invalidResponse('Anthropic');
      }
    } else if (block.type === 'redacted_thinking') {
      if (typeof block.data !== 'string') return invalidResponse('Anthropic');
    } else if (block.type === 'tool_use') {
      if (
        !isNonEmptyString(block.id) ||
        !isNonEmptyString(block.name) ||
        !isObject(block.input)
      ) {
        return invalidResponse('Anthropic');
      }
      calls.push({ id: block.id, name: block.name, arguments: block.input });
    } else {
      // This rejects server_tool_use, search results and unknown block types.
      return invalidResponse('Anthropic');
    }
  }

  const continuation = [{ role: 'assistant', content: value.content }];
  if (calls.length > 0) {
    if (value.stop_reason !== 'tool_use') return invalidResponse('Anthropic');
    return {
      turn: {
        text,
        model: value.model,
        finishReason: 'tool-calls',
        usage: parseAnthropicUsage(value.usage),
        calls,
      },
      continuation,
    };
  }

  let finishReason: ToolTurn['finishReason'];
  if (
    value.stop_reason === 'end_turn' ||
    value.stop_reason === 'stop_sequence'
  ) {
    if (text.length === 0) return invalidResponse('Anthropic');
    finishReason = 'completed';
  } else if (value.stop_reason === 'max_tokens') {
    finishReason = 'length';
  } else if (value.stop_reason === 'refusal') {
    finishReason = 'refusal';
  } else {
    return invalidResponse('Anthropic');
  }

  return {
    turn: {
      text,
      model: value.model,
      finishReason,
      usage: parseAnthropicUsage(value.usage),
      calls: [],
    },
    continuation,
  };
}

function resultsByCallId(
  results: ToolResult[],
  calls: ToolCall[],
  provider: 'OpenAI' | 'Anthropic',
): Map<string, ToolResult> {
  const byId = new Map(results.map((result) => [result.callId, result]));
  if (calls.some((call) => !byId.has(call.id)))
    return invalidResponse(provider);
  return byId;
}

export function openAIToolCodec(options: HostedCodecOptions): ToolCodec {
  return {
    initial(prompt) {
      return [{ role: 'user', content: prompt }];
    },
    async request(history, tools, requestOptions: ToolRequestOptions) {
      return requestJson({
        url: `${options.baseUrl}/responses`,
        method: 'POST',
        headers: { Authorization: `Bearer ${options.credential}` },
        body: {
          model: options.model,
          input: history,
          max_output_tokens: options.maxOutputTokens,
          store: false,
          stream: false,
          include: ['reasoning.encrypted_content'],
          ...(requestOptions.responseSchema === undefined
            ? {}
            : {
                text: {
                  format: {
                    type: 'json_schema',
                    name: 'agentforge_output',
                    strict: true,
                    schema: requestOptions.responseSchema,
                  },
                },
              }),
          tools: tools.map((tool: ToolDefinition) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: true,
          })),
        },
        timeoutMs: requestOptions.timeoutMs,
        approved: requestOptions.approved,
        signal: requestOptions.signal,
      });
    },
    stream(history, tools, requestOptions) {
      return streamOpenAIToolResponse(
        options,
        history,
        tools,
        requestOptions,
        parseOpenAIResponse,
      );
    },
    parse: parseOpenAIResponse,
    append(history, continuation, results, calls) {
      const byId = resultsByCallId(results, calls, 'OpenAI');
      return [
        ...history,
        ...continuation,
        ...calls.map((call) => {
          const result = byId.get(call.id)!;
          return {
            type: 'function_call_output',
            call_id: call.id,
            output: result.output,
          };
        }),
      ];
    },
  };
}

export function anthropicToolCodec(options: HostedCodecOptions): ToolCodec {
  return {
    initial(prompt) {
      return [{ role: 'user', content: prompt }];
    },
    async request(history, tools, requestOptions: ToolRequestOptions) {
      return requestJson({
        url: `${options.baseUrl}/messages`,
        method: 'POST',
        headers: {
          'x-api-key': options.credential,
          'anthropic-version': '2023-06-01',
        },
        body: {
          model: options.model,
          messages: history,
          max_tokens: options.maxOutputTokens,
          stream: false,
          ...(requestOptions.responseSchema === undefined
            ? {}
            : {
                output_config: {
                  format: {
                    type: 'json_schema',
                    schema: requestOptions.responseSchema,
                  },
                },
              }),
          tools: tools.map((tool: ToolDefinition) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
            strict: true,
          })),
        },
        timeoutMs: requestOptions.timeoutMs,
        approved: requestOptions.approved,
        signal: requestOptions.signal,
      });
    },
    stream(history, tools, requestOptions) {
      return streamAnthropicToolResponse(
        options,
        history,
        tools,
        requestOptions,
        parseAnthropicResponse,
      );
    },
    parse: parseAnthropicResponse,
    append(history, continuation, results, calls) {
      const byId = resultsByCallId(results, calls, 'Anthropic');
      return [
        ...history,
        ...continuation,
        {
          role: 'user',
          content: calls.map((call) => {
            const result = byId.get(call.id)!;
            return {
              type: 'tool_result',
              tool_use_id: call.id,
              content: result.output,
              ...(result.isError === undefined
                ? {}
                : { is_error: result.isError }),
            };
          }),
        },
      ];
    },
  };
}
