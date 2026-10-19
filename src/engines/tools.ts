import { createHash, randomUUID } from 'node:crypto';
import { ProviderError } from '../adapters/errors.js';
import {
  TOOL_ERROR_OUTPUT,
  validateToolResult,
} from '../adapters/tool-results.js';
import {
  cloneToolJson,
  prepareTools,
  validateToolCalls,
} from '../adapters/tools.js';
import { redact, redactValue } from '../shared/safety.js';
import type {
  RequestOptions,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolSession,
  ToolTurn,
  ToolStreamEvent,
} from '../adapters/types.js';
export interface RegisteredTool {
  definition: ToolDefinition;
  /** Trusted host code only. Tool definitions and provider output never supply handlers. */
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  review?(args: Record<string, unknown>): unknown;
}
export interface PendingToolBatch {
  readonly approvalId: string;
  readonly calls: ToolCall[];
  readonly review: unknown[];
  execute(input: {
    approved: boolean;
    approvalId: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<ToolResult[]>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function cancelled(): never {
  throw new ProviderError('cancelled', 'Tool execution cancelled.');
}
/** Approval is for this immutable batch, including its resolved host-side effects, once. */
export function prepareToolBatch(
  registry: RegisteredTool[],
  requested: ToolCall[],
): PendingToolBatch {
  const definitions = prepareTools(registry.map((tool) => tool.definition));
  const calls = freeze(validateToolCalls(definitions, requested));
  if (!calls.length)
    throw new ProviderError('validation', 'No tool calls to approve.');
  const registeredTools = new Map(
    registry.map((tool) => [tool.definition.name, tool] as const),
  );
  const preparedDefinitions = new Map(
    definitions.map((definition) => [definition.name, definition] as const),
  );
  const approvedTools = calls.map((call) => registeredTools.get(call.name)!);
  const handlers = calls.map((_call, index) => approvedTools[index]!.execute);
  const reviewers = approvedTools.map((tool) => tool.review);
  const review = freeze(
    cloneToolJson(
      calls.map((call, index) => {
        const definition = preparedDefinitions.get(call.name)!;
        return {
          callId: call.id,
          details:
            reviewers[index]?.call(
              approvedTools[index],
              cloneToolJson(call.arguments),
            ) ?? null,
          ...(definition.resultSchema === undefined
            ? {}
            : { resultSchema: definition.resultSchema }),
        };
      }),
      262144,
    ),
  );
  // Schemas are metadata: a property named token is a declaration, not a secret value.
  function sensitiveMetadata(value: unknown): boolean {
    if (typeof value === 'string') return redact(value) !== value;
    if (Array.isArray(value)) return value.some(sensitiveMetadata);
    if (value && typeof value === 'object')
      return Object.entries(value).some(
        ([key, item]) => redact(key) !== key || sensitiveMetadata(item),
      );
    return false;
  }
  const effects = review.map(({ callId, details }) => ({ callId, details }));
  if (
    JSON.stringify(redactValue(effects)) !== JSON.stringify(effects) ||
    review.some((item) => sensitiveMetadata(item.resultSchema))
  )
    throw new ProviderError(
      'policy',
      'Resolved tool review contains sensitive data; execution withheld.',
    );
  const approvalId = createHash('sha256')
    .update(randomUUID())
    .update(JSON.stringify({ calls, review }))
    .digest('hex');
  let consumed = false;
  return Object.freeze({
    approvalId,
    calls,
    review,
    async execute(input: {
      approved: boolean;
      approvalId: string;
      signal?: AbortSignal;
      timeoutMs?: number;
    }) {
      if (input.approved !== true || input.approvalId !== approvalId)
        throw new ProviderError(
          'policy',
          'Explicit approval for this exact tool batch is required.',
        );
      if (consumed)
        throw new ProviderError(
          'policy',
          'Tool batch approval has already been consumed.',
        );
      if (input.signal?.aborted) cancelled();
      const timeoutMs = input.timeoutMs ?? 30000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
        throw new ProviderError(
          'configuration',
          'Invalid tool execution timeout.',
        );
      consumed = true;
      const controller = new AbortController();
      const abort = () => controller.abort();
      input.signal?.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const interrupted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () =>
            reject(
              new ProviderError(
                input.signal?.aborted ? 'cancelled' : 'timeout',
                'Tool execution stopped.',
              ),
            ),
          { once: true },
        );
        timer = setTimeout(abort, timeoutMs);
      });
      const run = async () => {
        const results: ToolResult[] = [];
        for (const [index, call] of calls.entries()) {
          if (controller.signal.aborted) cancelled();
          let value: unknown;
          try {
            value = await handlers[index]!(
              cloneToolJson(call.arguments),
              controller.signal,
            );
          } catch {
            if (controller.signal.aborted) cancelled();
            results.push({
              callId: call.id,
              output: TOOL_ERROR_OUTPUT,
              isError: true,
            });
            continue;
          }
          if (controller.signal.aborted) cancelled();
          const resultSchema = preparedDefinitions.get(call.name)!.resultSchema;
          if (resultSchema !== undefined) {
            const output = JSON.stringify(cloneToolJson(value));
            results.push(
              validateToolResult({ callId: call.id, output }, resultSchema),
            );
            continue;
          }
          try {
            const output = redact(JSON.stringify(cloneToolJson(value)));
            if (Buffer.byteLength(output) > 65536)
              throw new ProviderError(
                'response-limit',
                'Tool result exceeds limit.',
              );
            results.push({ callId: call.id, output });
          } catch {
            if (controller.signal.aborted) cancelled();
            results.push({
              callId: call.id,
              output: TOOL_ERROR_OUTPUT,
              isError: true,
            });
          }
        }
        return results;
      };
      try {
        return await Promise.race([run(), interrupted]);
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
      }
    },
  });
}
export interface ToolConversationOptions {
  session: ToolSession;
  tools: RegisteredTool[];
  request: RequestOptions;
  approve(batch: PendingToolBatch): Promise<boolean>;
  onTurn?(turn: ToolTurn): void;
  onResults?(results: ToolResult[]): void;
  executionTimeoutMs?: number;
  stream?: boolean;
  onEvent?(event: ToolStreamEvent): void;
}
export type ToolConversationResult =
  | { status: 'completed'; turn: ToolTurn }
  | {
      status: 'approval-required';
      turn: ToolTurn;
      approvalId: string;
      review: unknown[];
    };
export async function runToolConversation(
  options: ToolConversationOptions,
): Promise<ToolConversationResult> {
  let results: ToolResult[] | undefined;
  for (let round = 0; round < 10; round++) {
    const request = {
      ...options.request,
      ...(results ? { results } : {}),
    };
    let turn: ToolTurn;
    if (options.stream) {
      if (!options.session.stream)
        throw new ProviderError(
          'unavailable',
          'Selected provider does not implement streaming client tools.',
        );
      let terminal: ToolTurn | undefined;
      for await (const event of options.session.stream(request)) {
        if (terminal)
          throw new ProviderError(
            'invalid-response',
            'Tool stream continued after completion.',
          );
        if (event.type === 'complete') terminal = event.turn;
        options.onEvent?.(event);
      }
      if (!terminal)
        throw new ProviderError(
          'invalid-response',
          'Tool stream ended without a validated turn.',
        );
      turn = terminal;
    } else turn = await options.session.next(request);
    options.onTurn?.(turn);
    if (turn.finishReason !== 'tool-calls')
      return { status: 'completed', turn };
    const batch = prepareToolBatch(options.tools, turn.calls);
    if ((await options.approve(batch)) !== true)
      return {
        status: 'approval-required',
        turn,
        approvalId: batch.approvalId,
        review: batch.review,
      };
    // Never execute a batch that cannot be followed by another bounded turn.
    if (round === 9)
      throw new ProviderError(
        'policy',
        'Tool conversation turn limit reached before execution.',
      );
    results = await batch.execute({
      approved: true,
      approvalId: batch.approvalId,
      signal: options.request.signal,
      timeoutMs: options.executionTimeoutMs,
    });
    options.onResults?.(results);
  }
  throw new ProviderError('policy', 'Tool conversation turn limit reached.');
}
