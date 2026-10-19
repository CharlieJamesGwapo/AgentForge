import { requestBytes, type JsonRequest } from './http.js';
import { ProviderError } from './errors.js';
export interface WireEvent {
  event?: string;
  data: unknown;
}
/** Incremental framing only: provider codecs must require their own terminal event. */
export async function* requestEvents(
  input: JsonRequest & { format: 'sse' | 'ndjson' },
): AsyncGenerator<WireEvent> {
  if (input.format !== 'sse' && input.format !== 'ndjson')
    throw new ProviderError('configuration', 'Unsupported stream format.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    eventName = '',
    dataLines: string[] = [];
  let events = 0;
  function parse(data: string, event?: string): WireEvent {
    events++;
    if (events > 10000)
      throw new ProviderError(
        'response-limit',
        'Provider stream exceeds the event limit.',
      );
    try {
      return { ...(event ? { event } : {}), data: JSON.parse(data) as unknown };
    } catch {
      throw new ProviderError(
        'invalid-response',
        'Provider returned malformed stream JSON. Content omitted.',
      );
    }
  }
  function line(value: string): WireEvent | undefined {
    if (input.format === 'ndjson')
      return value.trim() ? parse(value) : undefined;
    if (value === '') {
      const lines = dataLines;
      const event = eventName;
      dataLines = [];
      eventName = '';
      return lines.length
        ? parse(lines.join('\n'), event || undefined)
        : undefined;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon === -1 ? value : value.slice(0, colon);
    let content = colon === -1 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') eventName = content;
    else if (field === 'data') dataLines.push(content);
    return;
  }
  const request = {
    ...input,
    headers: {
      Accept:
        input.format === 'sse' ? 'text/event-stream' : 'application/x-ndjson',
      ...input.headers,
    },
  };
  for await (const chunk of requestBytes(request)) {
    try {
      buffer += decoder.decode(chunk, { stream: true });
    } catch {
      throw new ProviderError(
        'invalid-response',
        'Provider stream contains invalid UTF-8.',
      );
    }
    for (;;) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) break;
      const index = match.index;
      if (buffer[index] === '\r' && index === buffer.length - 1) break;
      const length =
        buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      const value = buffer.slice(0, index);
      buffer = buffer.slice(index + length);
      const event = line(value);
      if (event) yield event;
    }
  }
  try {
    buffer += decoder.decode();
  } catch {
    throw new ProviderError(
      'invalid-response',
      'Provider stream contains invalid UTF-8.',
    );
  }
  if (buffer.endsWith('\r')) {
    const event = line(buffer.slice(0, -1));
    buffer = '';
    if (event) yield event;
  }
  if (input.format === 'ndjson' && buffer.trim()) yield parse(buffer);
  // SSE requires a complete event separator; an unterminated event is not dispatched.
}
