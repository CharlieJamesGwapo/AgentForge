import type { ServerResponse } from 'node:http';
export type Protocol = 'openai' | 'anthropic' | 'ollama';
export type NativeCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
/** Deterministic native lifecycle fixtures, independent of production codec implementations. */
export function toolReply(
  provider: Protocol,
  calls: NativeCall[],
  finalText = '{"answer":"complete"}',
) {
  if (provider === 'openai')
    return {
      id: 'response1',
      status: 'completed',
      model: 'fixture',
      usage: { input_tokens: 12, output_tokens: 3 },
      output: calls.length
        ? calls.map((call, i) => ({
            id: `fc${i}`,
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
            status: 'completed',
          }))
        : [
            {
              id: 'message1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: finalText }],
            },
          ],
    };
  if (provider === 'anthropic')
    return {
      id: 'message1',
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      stop_reason: calls.length ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3 },
      content: calls.length
        ? calls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.arguments,
          }))
        : [{ type: 'text', text: finalText }],
    };
  return {
    model: 'fixture',
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 12,
    eval_count: 3,
    message: {
      role: 'assistant',
      content: calls.length ? '' : finalText,
      ...(calls.length
        ? {
            tool_calls: calls.map((call) => ({
              id: call.id,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    },
  };
}
export async function sendToolReply(
  res: ServerResponse,
  provider: Protocol,
  calls: NativeCall[],
  stream: boolean,
  finalText = '{"answer":"complete"}',
) {
  const reply = toolReply(provider, calls, finalText);
  if (!stream) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply));
    return;
  }
  if (provider === 'ollama') {
    res.setHeader('content-type', 'application/x-ndjson');
    res.end(JSON.stringify(reply) + '\n');
    return;
  }
  res.setHeader('content-type', 'text/event-stream');
  const events: unknown[] = [];
  if (provider === 'anthropic') {
    events.push({
      type: 'message_start',
      message: {
        id: 'message1',
        type: 'message',
        role: 'assistant',
        model: 'fixture',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    });
    const blocks = calls.length
      ? calls.map((c) => ({
          type: 'tool_use',
          id: c.id,
          name: c.name,
          input: {},
        }))
      : [{ type: 'text', text: '' }];
    blocks.forEach((block, index) => {
      events.push({ type: 'content_block_start', index, content_block: block });
      if (calls.length) {
        const args = JSON.stringify(calls[index]!.arguments);
        for (const part of [args.slice(0, 2), args.slice(2)])
          events.push({
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: part },
          });
      } else
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: finalText },
        });
      events.push({ type: 'content_block_stop', index });
    });
    events.push(
      {
        type: 'message_delta',
        delta: {
          stop_reason: calls.length ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    );
  } else {
    events.push({
      type: 'response.created',
      response: { id: 'response1', status: 'in_progress' },
    });
    if (calls.length)
      calls.forEach((call, index) => {
        const id = `fc${index}`,
          args = JSON.stringify(call.arguments),
          initial = {
            id,
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: '',
            status: 'in_progress',
          };
        events.push({
          type: 'response.output_item.added',
          output_index: index,
          item: initial,
        });
        for (const delta of [args.slice(0, 2), args.slice(2)])
          events.push({
            type: 'response.function_call_arguments.delta',
            output_index: index,
            item_id: id,
            delta,
          });
        events.push(
          {
            type: 'response.function_call_arguments.done',
            output_index: index,
            item_id: id,
            arguments: args,
          },
          {
            type: 'response.output_item.done',
            output_index: index,
            item: { ...initial, status: 'completed', arguments: args },
          },
        );
      });
    else {
      const item = {
        id: 'message1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: finalText }],
      };
      events.push(
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, status: 'in_progress', content: [] },
        },
        {
          type: 'response.content_part.added',
          output_index: 0,
          item_id: 'message1',
          content_index: 0,
          part: { type: 'output_text', text: '' },
        },
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'message1',
          content_index: 0,
          delta: finalText,
        },
        {
          type: 'response.output_text.done',
          output_index: 0,
          item_id: 'message1',
          content_index: 0,
          text: finalText,
        },
        {
          type: 'response.content_part.done',
          output_index: 0,
          item_id: 'message1',
          content_index: 0,
          part: item.content[0],
        },
        { type: 'response.output_item.done', output_index: 0, item },
      );
    }
    events.push({ type: 'response.completed', response: reply });
  }
  const wire = Buffer.from(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  );
  for (let offset = 0; offset < wire.length; offset += 113) {
    if (res.destroyed) return;
    res.write(wire.subarray(offset, offset + 113));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  res.end();
}
