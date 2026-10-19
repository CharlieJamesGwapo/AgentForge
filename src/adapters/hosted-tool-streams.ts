import { ProviderError } from './errors.js';
import { requestEvents } from './streaming.js';
import type { NativeToolStreamEvent, ToolCodec } from './tools.js';
import type { ToolRequestOptions, ToolDefinition } from './types.js';

interface HostedCodecOptions {
  model: string;
  baseUrl: string;
  credential: string;
  maxOutputTokens: number;
}

type ParsedToolResponse = ReturnType<ToolCodec['parse']>;
type ParseResponse = (response: unknown) => ParsedToolResponse;
type JsonObject = Record<string, unknown>;

interface OutputItemState {
  id: string;
  type: string;
  done: boolean;
  functionCall?: {
    callId: string;
    name: string;
    arguments: string;
    argumentsDone: boolean;
  };
  parts?: Map<number, TextPartState>;
}

interface TextPartState {
  type: 'output_text' | 'refusal';
  text: string;
  done: boolean;
}

interface AnthropicBlock {
  type: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use';
  text?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  partialJson?: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function invalidResponse(provider: 'OpenAI' | 'Anthropic'): never {
  throw new ProviderError(
    'invalid-response',
    `${provider} returned an invalid tool stream response.`,
  );
}

function failedResponse(provider: 'OpenAI' | 'Anthropic'): never {
  throw new ProviderError(
    'unavailable',
    `${provider} tool stream failed. Provider details omitted.`,
  );
}

function cancelled(provider: 'OpenAI' | 'Anthropic'): never {
  throw new ProviderError(
    'cancelled',
    `${provider} tool stream was cancelled.`,
  );
}

function checkResponseId(
  value: JsonObject,
  responseId: string | undefined,
  provider: 'OpenAI',
): string | undefined {
  if (value.response_id !== undefined) {
    if (!isNonEmptyString(value.response_id)) return invalidResponse(provider);
    if (responseId !== undefined && value.response_id !== responseId)
      return invalidResponse(provider);
    return value.response_id;
  }
  return responseId;
}

function openAIItemType(
  value: unknown,
): value is 'function_call' | 'message' | 'reasoning' {
  return (
    value === 'function_call' || value === 'message' || value === 'reasoning'
  );
}

function validInitialOutputItem(item: JsonObject): boolean {
  if (!openAIItemType(item.type) || !isNonEmptyString(item.id)) return false;
  if (
    item.status !== undefined &&
    !['in_progress', 'completed'].includes(String(item.status))
  )
    return false;
  if (item.type === 'function_call') {
    return (
      isNonEmptyString(item.call_id) &&
      isNonEmptyString(item.name) &&
      typeof item.arguments === 'string'
    );
  }
  if (item.type === 'message') {
    return (
      (item.role === undefined || item.role === 'assistant') &&
      (item.content === undefined || Array.isArray(item.content))
    );
  }
  return item.summary === undefined || Array.isArray(item.summary);
}

function addOutputItem(
  outputItems: Map<number, OutputItemState>,
  itemIds: Set<string>,
  callIds: Set<string>,
  outputIndex: unknown,
  value: unknown,
): void {
  if (
    !isIndex(outputIndex) ||
    !isObject(value) ||
    !validInitialOutputItem(value)
  )
    return invalidResponse('OpenAI');
  const id = value.id as string;
  if (outputItems.has(outputIndex) || itemIds.has(id))
    return invalidResponse('OpenAI');
  itemIds.add(id);
  const state: OutputItemState = {
    id,
    type: value.type as string,
    done: false,
  };
  if (value.type === 'function_call') {
    const callId = value.call_id as string;
    if (callIds.has(callId)) return invalidResponse('OpenAI');
    callIds.add(callId);
    state.functionCall = {
      callId,
      name: value.name as string,
      arguments: value.arguments as string,
      argumentsDone: false,
    };
  } else if (value.type === 'message') {
    state.parts = new Map();
  }
  outputItems.set(outputIndex, state);
}

function matchOutputItem(
  outputItems: Map<number, OutputItemState>,
  outputIndex: unknown,
  itemId: unknown,
  expectedType: string,
): OutputItemState {
  if (!isIndex(outputIndex) || !isNonEmptyString(itemId))
    return invalidResponse('OpenAI');
  const state = outputItems.get(outputIndex);
  if (
    !state ||
    state.id !== itemId ||
    state.type !== expectedType ||
    state.done
  )
    return invalidResponse('OpenAI');
  return state;
}

function partKey(value: unknown): number {
  if (!isIndex(value)) return invalidResponse('OpenAI');
  return value;
}

function openAITextPart(
  state: OutputItemState,
  contentIndex: unknown,
  type: 'output_text' | 'refusal',
): TextPartState {
  const index = partKey(contentIndex);
  if (!state.parts) return invalidResponse('OpenAI');
  const part = state.parts.get(index);
  if (!part || part.type !== type || part.done)
    return invalidResponse('OpenAI');
  return part;
}

function validateTerminalOpenAI(
  response: unknown,
  outputItems: Map<number, OutputItemState>,
  responseId: string | undefined,
  parse: ParseResponse,
  streamedText: string,
): ParsedToolResponse {
  if (!isObject(response) || !Array.isArray(response.output))
    return invalidResponse('OpenAI');
  if (responseId !== undefined && response.id !== responseId)
    return invalidResponse('OpenAI');
  if (response.output.length !== outputItems.size)
    return invalidResponse('OpenAI');

  for (let index = 0; index < response.output.length; index++) {
    const item = response.output[index];
    const state = outputItems.get(index);
    if (
      !state ||
      !state.done ||
      !isObject(item) ||
      item.id !== state.id ||
      item.type !== state.type
    ) {
      return invalidResponse('OpenAI');
    }
    if (state.functionCall) {
      if (
        !state.functionCall.argumentsDone ||
        item.call_id !== state.functionCall.callId ||
        item.name !== state.functionCall.name ||
        item.arguments !== state.functionCall.arguments
      ) {
        return invalidResponse('OpenAI');
      }
    }
    if (state.parts) {
      if (
        !Array.isArray(item.content) ||
        item.content.length !== state.parts.size
      )
        return invalidResponse('OpenAI');
      for (let partIndex = 0; partIndex < item.content.length; partIndex++) {
        const part = item.content[partIndex];
        const streamedPart = state.parts.get(partIndex);
        if (
          !isObject(part) ||
          !streamedPart ||
          !streamedPart.done ||
          part.type !== streamedPart.type ||
          (streamedPart.type === 'output_text'
            ? part.text !== streamedPart.text
            : part.refusal !== streamedPart.text)
        ) {
          return invalidResponse('OpenAI');
        }
      }
    }
  }

  const parsed = parse(response);
  if (parsed.turn.text !== streamedText) return invalidResponse('OpenAI');
  return parsed;
}

export async function* streamOpenAIToolResponse(
  options: HostedCodecOptions,
  history: unknown[],
  tools: ToolDefinition[],
  requestOptions: ToolRequestOptions,
  parse: ParseResponse,
): AsyncGenerator<NativeToolStreamEvent> {
  const outputItems = new Map<number, OutputItemState>();
  const itemIds = new Set<string>();
  const callIds = new Set<string>();
  const reasoningText = new Map<string, string>();
  let responseId: string | undefined;
  let terminal:
    { event: 'completed' | 'incomplete'; response: unknown } | undefined;
  let streamedText = '';

  for await (const event of requestEvents({
    url: `${options.baseUrl}/responses`,
    method: 'POST',
    headers: { Authorization: `Bearer ${options.credential}` },
    body: {
      model: options.model,
      input: history,
      max_output_tokens: options.maxOutputTokens,
      store: false,
      stream: true,
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
      tools: tools.map((tool) => ({
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
    format: 'sse',
  })) {
    if (terminal) return invalidResponse('OpenAI');
    if (event.event === 'error') return failedResponse('OpenAI');
    if (!isObject(event.data) || !isNonEmptyString(event.data.type))
      return invalidResponse('OpenAI');
    const data = event.data;
    responseId = checkResponseId(data, responseId, 'OpenAI');
    const type = data.type;

    if (type === 'error' || type === 'response.failed')
      return failedResponse('OpenAI');
    if (type === 'response.cancelled') return cancelled('OpenAI');

    if (
      type === 'response.created' ||
      type === 'response.in_progress' ||
      type === 'response.queued'
    ) {
      if (!isObject(data.response)) return invalidResponse('OpenAI');
      const id = data.response.id;
      if (id !== undefined) {
        if (
          !isNonEmptyString(id) ||
          (responseId !== undefined && responseId !== id)
        )
          return invalidResponse('OpenAI');
        responseId = id;
      }
      const expectedStatus =
        type === 'response.created'
          ? 'in_progress'
          : type === 'response.queued'
            ? 'queued'
            : 'in_progress';
      if (data.response.status !== expectedStatus)
        return invalidResponse('OpenAI');
      continue;
    }

    if (type === 'response.output_item.added') {
      addOutputItem(
        outputItems,
        itemIds,
        callIds,
        data.output_index,
        data.item,
      );
      continue;
    }

    if (type === 'response.function_call_arguments.delta') {
      const state = matchOutputItem(
        outputItems,
        data.output_index,
        data.item_id,
        'function_call',
      );
      if (
        !state.functionCall ||
        state.functionCall.argumentsDone ||
        typeof data.delta !== 'string'
      )
        return invalidResponse('OpenAI');
      state.functionCall.arguments += data.delta;
      continue;
    }

    if (type === 'response.function_call_arguments.done') {
      const state = matchOutputItem(
        outputItems,
        data.output_index,
        data.item_id,
        'function_call',
      );
      if (
        !state.functionCall ||
        state.functionCall.argumentsDone ||
        typeof data.arguments !== 'string' ||
        data.arguments !== state.functionCall.arguments
      ) {
        return invalidResponse('OpenAI');
      }
      state.functionCall.argumentsDone = true;
      continue;
    }

    if (type === 'response.output_item.done') {
      if (!isIndex(data.output_index) || !isObject(data.item))
        return invalidResponse('OpenAI');
      const state = outputItems.get(data.output_index);
      if (
        !state ||
        state.done ||
        data.item.id !== state.id ||
        data.item.type !== state.type
      ) {
        return invalidResponse('OpenAI');
      }
      if (state.functionCall) {
        if (
          !state.functionCall.argumentsDone ||
          data.item.call_id !== state.functionCall.callId ||
          data.item.name !== state.functionCall.name ||
          data.item.arguments !== state.functionCall.arguments
        ) {
          return invalidResponse('OpenAI');
        }
      }
      if (state.parts) {
        if (
          !Array.isArray(data.item.content) ||
          data.item.content.length !== state.parts.size
        )
          return invalidResponse('OpenAI');
        for (let index = 0; index < data.item.content.length; index++) {
          const part = data.item.content[index];
          const current = state.parts.get(index);
          if (
            !isObject(part) ||
            !current ||
            !current.done ||
            part.type !== current.type ||
            (current.type === 'output_text'
              ? part.text !== current.text
              : part.refusal !== current.text)
          ) {
            return invalidResponse('OpenAI');
          }
        }
      }
      state.done = true;
      continue;
    }

    if (type === 'response.content_part.added') {
      if (
        !isIndex(data.content_index) ||
        !isObject(data.part) ||
        (data.part.type !== 'output_text' && data.part.type !== 'refusal')
      ) {
        return invalidResponse('OpenAI');
      }
      const state = matchOutputItem(
        outputItems,
        data.output_index,
        data.item_id,
        'message',
      );
      if (
        typeof data.part.text !== 'string' &&
        typeof data.part.refusal !== 'string'
      )
        return invalidResponse('OpenAI');
      if (
        (data.part.type === 'output_text' &&
          typeof data.part.text !== 'string') ||
        (data.part.type === 'refusal' && typeof data.part.refusal !== 'string')
      ) {
        return invalidResponse('OpenAI');
      }
      if (state.parts?.has(data.content_index))
        return invalidResponse('OpenAI');
      const text =
        data.part.type === 'output_text'
          ? (data.part.text as string)
          : (data.part.refusal as string);
      state.parts!.set(data.content_index, {
        type: data.part.type,
        text,
        done: false,
      });
      if (text.length > 0) {
        streamedText += text;
        if (requestOptions.responseSchema === undefined)
          yield { type: 'text-delta', text };
      }
      continue;
    }

    if (
      type === 'response.output_text.delta' ||
      type === 'response.refusal.delta'
    ) {
      if (typeof data.delta !== 'string') return invalidResponse('OpenAI');
      const partType =
        type === 'response.output_text.delta' ? 'output_text' : 'refusal';
      const state = matchOutputItem(
        outputItems,
        data.output_index,
        data.item_id,
        'message',
      );
      const part = openAITextPart(state, data.content_index, partType);
      part.text += data.delta;
      if (data.delta.length > 0) {
        streamedText += data.delta;
        if (requestOptions.responseSchema === undefined)
          yield { type: 'text-delta', text: data.delta };
      }
      continue;
    }

    if (
      type === 'response.output_text.done' ||
      type === 'response.refusal.done'
    ) {
      const partType =
        type === 'response.output_text.done' ? 'output_text' : 'refusal';
      const value =
        type === 'response.output_text.done' ? data.text : data.refusal;
      if (typeof value !== 'string') return invalidResponse('OpenAI');
      const state = matchOutputItem(
        outputItems,
        data.output_index,
        data.item_id,
        'message',
      );
      const part = openAITextPart(state, data.content_index, partType);
      if (value !== part.text) return invalidResponse('OpenAI');
      continue;
    }

    if (type === 'response.content_part.done') {
      if (!isObject(data.part)) return invalidResponse('OpenAI');
      const partType = data.part.type;
      if (partType !== 'output_text' && partType !== 'refusal')
        return invalidResponse('OpenAI');
      const state = matchOutputItem(
        outputItems,
        data.output_index,
        data.item_id,
        'message',
      );
      const part = openAITextPart(state, data.content_index, partType);
      const value =
        partType === 'output_text' ? data.part.text : data.part.refusal;
      if (typeof value !== 'string' || value !== part.text)
        return invalidResponse('OpenAI');
      part.done = true;
      continue;
    }

    if (type === 'response.reasoning_summary_part.added') {
      if (
        !isIndex(data.output_index) ||
        !isIndex(data.summary_index) ||
        !isObject(data.part) ||
        data.part.type !== 'summary_text' ||
        typeof data.part.text !== 'string'
      ) {
        return invalidResponse('OpenAI');
      }
      const state = matchOutputItem(
        outputItems,
        data.output_index,
        data.item_id,
        'reasoning',
      );
      const key = `${state.id}:${data.summary_index}`;
      if (reasoningText.has(key)) return invalidResponse('OpenAI');
      reasoningText.set(key, data.part.text);
      continue;
    }

    if (
      type === 'response.reasoning_summary_text.delta' ||
      type === 'response.reasoning_text.delta'
    ) {
      if (
        !isIndex(data.output_index) ||
        !isNonEmptyString(data.item_id) ||
        typeof data.delta !== 'string'
      ) {
        return invalidResponse('OpenAI');
      }
      const state = outputItems.get(data.output_index);
      if (
        !state ||
        state.id !== data.item_id ||
        state.type !== 'reasoning' ||
        state.done
      )
        return invalidResponse('OpenAI');
      const key = `${state.id}:${type === 'response.reasoning_text.delta' ? 'content' : (data.summary_index ?? 0)}`;
      reasoningText.set(key, (reasoningText.get(key) ?? '') + data.delta);
      continue;
    }

    if (
      type === 'response.reasoning_summary_text.done' ||
      type === 'response.reasoning_text.done'
    ) {
      if (
        !isIndex(data.output_index) ||
        !isNonEmptyString(data.item_id) ||
        typeof data.text !== 'string'
      ) {
        return invalidResponse('OpenAI');
      }
      const state = outputItems.get(data.output_index);
      if (
        !state ||
        state.id !== data.item_id ||
        state.type !== 'reasoning' ||
        state.done
      )
        return invalidResponse('OpenAI');
      const key = `${state.id}:${type === 'response.reasoning_text.done' ? 'content' : (data.summary_index ?? 0)}`;
      if (reasoningText.get(key) !== data.text)
        return invalidResponse('OpenAI');
      continue;
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      if (!isObject(data.response)) return invalidResponse('OpenAI');
      const expectedStatus =
        type === 'response.completed' ? 'completed' : 'incomplete';
      if (data.response.status !== expectedStatus)
        return invalidResponse('OpenAI');
      responseId = checkResponseId(data, responseId, 'OpenAI');
      terminal = { event: expectedStatus, response: data.response };
      continue;
    }

    return invalidResponse('OpenAI');
  }

  if (!terminal) return invalidResponse('OpenAI');
  validateTerminalOpenAI(
    terminal.response,
    outputItems,
    responseId,
    parse,
    streamedText,
  );
  yield { type: 'response', response: terminal.response };
}

function anthropicBlockStart(value: unknown): AnthropicBlock {
  if (!isObject(value) || !isNonEmptyString(value.type))
    return invalidResponse('Anthropic');
  if (value.type === 'text') {
    if (typeof value.text !== 'string') return invalidResponse('Anthropic');
    return { type: 'text', text: value.text };
  }
  if (value.type === 'thinking') {
    if (
      typeof value.thinking !== 'string' ||
      typeof value.signature !== 'string'
    )
      return invalidResponse('Anthropic');
    return {
      type: 'thinking',
      text: value.thinking,
      signature: value.signature,
    };
  }
  if (value.type === 'redacted_thinking') {
    if (typeof value.data !== 'string') return invalidResponse('Anthropic');
    return { type: 'redacted_thinking', data: value.data };
  }
  if (value.type === 'tool_use') {
    if (
      !isNonEmptyString(value.id) ||
      !isNonEmptyString(value.name) ||
      !isObject(value.input) ||
      Object.keys(value.input).length > 0
    ) {
      return invalidResponse('Anthropic');
    }
    return {
      type: 'tool_use',
      id: value.id,
      name: value.name,
      partialJson: '',
    };
  }
  return invalidResponse('Anthropic');
}

function anthropicBlockValue(block: AnthropicBlock): JsonObject {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'thinking')
    return {
      type: 'thinking',
      thinking: block.text,
      signature: block.signature,
    };
  if (block.type === 'redacted_thinking')
    return { type: 'redacted_thinking', data: block.data };
  if (!block.input) return invalidResponse('Anthropic');
  return {
    type: 'tool_use',
    id: block.id,
    name: block.name,
    input: block.input,
  };
}

function appendAnthropicUsage(initial: unknown, final: unknown): unknown {
  if (initial === undefined) return final;
  if (final === undefined) return initial;
  if (!isObject(initial) || !isObject(final))
    return invalidResponse('Anthropic');
  return { ...initial, ...final };
}

export async function* streamAnthropicToolResponse(
  options: HostedCodecOptions,
  history: unknown[],
  tools: ToolDefinition[],
  requestOptions: ToolRequestOptions,
  parse: ParseResponse,
): AsyncGenerator<NativeToolStreamEvent> {
  let started = false;
  let model = '';
  let messageId = '';
  let inputUsage: unknown;
  let outputUsage: unknown;
  let stopReason: string | undefined;
  let stopSequence: unknown;
  let messageDeltaSeen = false;
  let messageStopped = false;
  let activeIndex: number | undefined;
  let nextBlockIndex = 0;
  let activeBlock: AnthropicBlock | undefined;
  const blocks: JsonObject[] = [];
  let streamedText = '';

  for await (const event of requestEvents({
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
      stream: true,
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
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        strict: true,
      })),
    },
    timeoutMs: requestOptions.timeoutMs,
    approved: requestOptions.approved,
    signal: requestOptions.signal,
    format: 'sse',
  })) {
    if (messageStopped) return invalidResponse('Anthropic');
    if (event.event === 'error') return failedResponse('Anthropic');
    if (!isObject(event.data) || !isNonEmptyString(event.data.type))
      return invalidResponse('Anthropic');
    const data = event.data;
    const type = data.type;

    if (type === 'error') return failedResponse('Anthropic');
    if (type === 'ping') continue;

    if (type === 'message_start') {
      if (started || !isObject(data.message))
        return invalidResponse('Anthropic');
      const message = data.message;
      if (
        message.type !== 'message' ||
        message.role !== 'assistant' ||
        !isNonEmptyString(message.id) ||
        !isNonEmptyString(message.model) ||
        !Array.isArray(message.content) ||
        message.content.length !== 0 ||
        (message.stop_reason !== null && message.stop_reason !== undefined) ||
        (message.stop_sequence !== null && message.stop_sequence !== undefined)
      ) {
        return invalidResponse('Anthropic');
      }
      started = true;
      model = message.model;
      messageId = message.id;
      inputUsage = message.usage;
      continue;
    }

    if (type === 'content_block_start') {
      if (
        !started ||
        messageDeltaSeen ||
        activeIndex !== undefined ||
        !isIndex(data.index) ||
        data.index !== nextBlockIndex
      ) {
        return invalidResponse('Anthropic');
      }
      activeIndex = data.index;
      activeBlock = anthropicBlockStart(data.content_block);
      if (
        activeBlock.type === 'tool_use' &&
        blocks.some((block) => block.id === activeBlock?.id)
      )
        return invalidResponse('Anthropic');
      if (activeBlock.type === 'text' && activeBlock.text!.length > 0) {
        const text = activeBlock.text!;
        streamedText += text;
        if (requestOptions.responseSchema === undefined)
          yield { type: 'text-delta', text };
      }
      continue;
    }

    if (type === 'content_block_delta') {
      if (
        !started ||
        messageDeltaSeen ||
        activeIndex === undefined ||
        activeIndex !== data.index ||
        !activeBlock ||
        !isObject(data.delta) ||
        !isNonEmptyString(data.delta.type)
      ) {
        return invalidResponse('Anthropic');
      }
      const delta = data.delta;
      if (delta.type === 'text_delta' && activeBlock.type === 'text') {
        if (typeof delta.text !== 'string') return invalidResponse('Anthropic');
        activeBlock.text = (activeBlock.text ?? '') + delta.text;
        if (delta.text.length > 0) {
          streamedText += delta.text;
          if (requestOptions.responseSchema === undefined)
            yield { type: 'text-delta', text: delta.text };
        }
        continue;
      }
      if (delta.type === 'thinking_delta' && activeBlock.type === 'thinking') {
        if (typeof delta.thinking !== 'string')
          return invalidResponse('Anthropic');
        activeBlock.text = (activeBlock.text ?? '') + delta.thinking;
        continue;
      }
      if (delta.type === 'signature_delta' && activeBlock.type === 'thinking') {
        if (typeof delta.signature !== 'string')
          return invalidResponse('Anthropic');
        activeBlock.signature = (activeBlock.signature ?? '') + delta.signature;
        continue;
      }
      if (
        delta.type === 'input_json_delta' &&
        activeBlock.type === 'tool_use'
      ) {
        if (typeof delta.partial_json !== 'string')
          return invalidResponse('Anthropic');
        activeBlock.partialJson =
          (activeBlock.partialJson ?? '') + delta.partial_json;
        continue;
      }
      return invalidResponse('Anthropic');
    }

    if (type === 'content_block_stop') {
      if (
        !started ||
        messageDeltaSeen ||
        activeIndex === undefined ||
        activeIndex !== data.index ||
        !activeBlock
      ) {
        return invalidResponse('Anthropic');
      }
      if (activeBlock.type === 'tool_use') {
        if ((activeBlock.partialJson ?? '') === '') {
          activeBlock.input = {};
        } else {
          let input: unknown;
          try {
            input = JSON.parse(activeBlock.partialJson!);
          } catch {
            return invalidResponse('Anthropic');
          }
          if (!isObject(input)) return invalidResponse('Anthropic');
          activeBlock.input = input;
        }
      }
      blocks.push(anthropicBlockValue(activeBlock));
      activeIndex = undefined;
      activeBlock = undefined;
      nextBlockIndex++;
      continue;
    }

    if (type === 'message_delta') {
      if (
        !started ||
        activeIndex !== undefined ||
        !isObject(data.delta) ||
        (data.delta.stop_reason !== undefined &&
          data.delta.stop_reason !== null &&
          !isNonEmptyString(data.delta.stop_reason)) ||
        (data.delta.stop_sequence !== null &&
          data.delta.stop_sequence !== undefined &&
          typeof data.delta.stop_sequence !== 'string')
      ) {
        return invalidResponse('Anthropic');
      }
      if (isNonEmptyString(data.delta.stop_reason)) {
        if (stopReason !== undefined) return invalidResponse('Anthropic');
        stopReason = data.delta.stop_reason;
        stopSequence = data.delta.stop_sequence;
      }
      if (data.usage !== undefined && !isObject(data.usage))
        return invalidResponse('Anthropic');
      if (data.usage !== undefined)
        outputUsage = appendAnthropicUsage(outputUsage, data.usage);
      messageDeltaSeen = true;
      continue;
    }

    if (type === 'message_stop') {
      if (!started || !messageDeltaSeen || activeIndex !== undefined)
        return invalidResponse('Anthropic');
      messageStopped = true;
      continue;
    }

    return invalidResponse('Anthropic');
  }

  if (!messageStopped || !stopReason) return invalidResponse('Anthropic');
  const response = {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: stopSequence ?? null,
    usage: appendAnthropicUsage(inputUsage, outputUsage),
  };
  const parsed = parse(response);
  if (parsed.turn.text !== streamedText) return invalidResponse('Anthropic');
  yield { type: 'response', response };
}
