import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type RequestListener } from 'node:http';
import { requestEvents } from '../src/adapters/streaming.js';
async function fixture(t: test.TestContext, handler: RequestListener) {
  const s = createServer(handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  const address = s.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
const options = { approved: true, timeoutMs: 1000, method: 'POST' as const };
async function values(url: string, format: 'sse' | 'ndjson', extra = {}) {
  const values = [];
  for await (const event of requestEvents({
    ...options,
    url,
    format,
    ...extra,
  }))
    values.push(event);
  return values;
}
test('incremental SSE supports comments, CRLF, multiline JSON and fragmented UTF8', async (t) => {
  const bytes = Buffer.from(
    ': ping\r\nevent: delta\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\n',
  );
  const url = await fixture(t, (_, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    for (const byte of bytes) res.write(Buffer.from([byte]));
    res.end();
  });
  assert.deepEqual(await values(url, 'sse'), [
    { event: 'delta', data: { text: '你好' } },
  ]);
});
test('NDJSON supports multiple records and a final record without a newline', async (t) => {
  const url = await fixture(t, (_, res) => {
    res.end('{"a":1}\n{"b":2}');
  });
  assert.deepEqual(await values(url, 'ndjson'), [
    { data: { a: 1 } },
    { data: { b: 2 } },
  ]);
});
test('malformed stream data is content-safe; stream byte limits remain enforced', async (t) => {
  const url = await fixture(t, (_, res) =>
    res.end('data: sensitive-not-json\n\n'),
  );
  await assert.rejects(
    values(url, 'sse'),
    (e: Error & { code?: string }) =>
      e.code === 'invalid-response' &&
      !e.message.includes('sensitive-not-json'),
  );
  await assert.rejects(values(url, 'sse', { maxResponseBytes: 5 }), {
    code: 'response-limit',
  });
});
test('slow streams time out and cancellation closes the active body', async (t) => {
  let closed = false;
  const url = await fixture(t, (req, res) => {
    req.on('close', () => (closed = true));
    res.write('data: {}\n\n');
  });
  await assert.rejects(values(url, 'sse', { timeoutMs: 40 }), {
    code: 'timeout',
  });
  const controller = new AbortController();
  const pending = values(url, 'sse', { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { code: 'cancelled' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(closed);
});
test('stream consumers can stop early without leaking connections', async (t) => {
  let closed = false;
  const url = await fixture(t, (req, res) => {
    req.on('close', () => (closed = true));
    res.write('data: {}\n\n');
  });
  for await (const _event of requestEvents({
    ...options,
    url,
    format: 'sse',
  })) {
    void _event;
    break;
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(closed);
});

test('SSE accepts a terminal blank line ending in bare CR at EOF', async (t) => {
  const url = await fixture(t, (_, res) => res.end('data: {"x":1}\r\r'));
  assert.deepEqual(await values(url, 'sse'), [{ data: { x: 1 } }]);
});
