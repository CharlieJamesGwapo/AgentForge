import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type RequestListener } from 'node:http';
import {
  requestJson,
  validateBaseUrl,
  validateProviderOptions,
} from '../src/adapters/http.js';

async function server(t: test.TestContext, handler: RequestListener) {
  const instance = createServer(handler);
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(() => {
    instance.closeAllConnections();
    instance.close();
  });
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
const options = { method: 'GET' as const, timeoutMs: 1000, approved: true };

test('HTTP transport requires approval and validates URLs before sending', async (t) => {
  let requests = 0;
  const url = await server(t, (_, res) => {
    requests++;
    res.end('{}');
  });
  await assert.rejects(requestJson({ ...options, url, approved: false }), {
    code: 'policy',
  });
  for (const value of [
    'http://example.com/v1',
    'https://name:secret@example.com',
    'https://example.com/?token=private',
    'https://example.com/#private',
    'file:///tmp/test',
    ' https://example.com',
  ])
    assert.throws(() => validateBaseUrl(value));
  assert.equal(requests, 0);
  assert.equal(validateBaseUrl(url + '/v1/'), url + '/v1');
  assert.equal(
    validateBaseUrl('https://example.com/v1'),
    'https://example.com/v1',
  );
});

test('transport reads bounded JSON and never follows redirects', async (t) => {
  let redirected = 0;
  const target = await server(t, (_, res) => {
    redirected++;
    res.end('{}');
  });
  const url = await server(t, (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(307, { Location: target });
      res.end('private response');
    } else res.end('{"ok":true}');
  });
  assert.deepEqual(await requestJson({ ...options, url }), { ok: true });
  await assert.rejects(requestJson({ ...options, url: url + '/redirect' }), {
    code: 'policy',
  });
  assert.equal(redirected, 0);
});

test('HTTP errors are normalized without response content or automatic retry', async (t) => {
  for (const [status, code] of [
    [401, 'authentication'],
    [403, 'authentication'],
    [429, 'rate-limit'],
    [500, 'unavailable'],
  ] as const) {
    let count = 0;
    const url = await server(t, (_, res) => {
      count++;
      res.writeHead(status);
      res.end('sensitive-unrecognized-server-error');
    });
    await assert.rejects(
      requestJson({ ...options, url }),
      (error: Error & { code?: string }) =>
        error.code === code &&
        !error.message.includes('sensitive-unrecognized'),
    );
    assert.equal(count, 1);
  }
});

test('timeout covers headers and slow response bodies; caller cancellation propagates', async (t) => {
  const url = await server(t, (req, res) => {
    if (req.url === '/body') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
    }
  });
  for (const suffix of ['', '/body']) {
    const started = Date.now();
    await assert.rejects(
      requestJson({ ...options, url: url + suffix, timeoutMs: 50 }),
      { code: 'timeout' },
    );
    assert.ok(Date.now() - started < 1000);
  }
  const controller = new AbortController();
  const pending = requestJson({ ...options, url, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { code: 'cancelled' });
  controller.abort();
  await assert.rejects(
    requestJson({ ...options, url, signal: controller.signal }),
    { code: 'cancelled' },
  );
});

test('response limits apply to advertised and chunked bodies; invalid JSON is content-safe', async (t) => {
  const url = await server(t, (req, res) => {
    if (req.url === '/json') {
      res.end('sensitive-invalid-json');
      return;
    }
    if (req.url === '/length') res.setHeader('Content-Length', '10000');
    res.end('x'.repeat(1000));
  });
  for (const suffix of ['/length', '/chunked'])
    await assert.rejects(
      requestJson({ ...options, url: url + suffix, maxResponseBytes: 100 }),
      { code: 'response-limit' },
    );
  await assert.rejects(
    requestJson({ ...options, url: url + '/json' }),
    (error: Error & { code?: string }) =>
      error.code === 'invalid-response' &&
      !error.message.includes('sensitive-invalid-json'),
  );
});

test('provider options reject inline credentials, invalid limits and noncredential environment references', () => {
  const valid = validateProviderOptions(
    { model: 'chosen-model' },
    'https://example.com/v1',
    'EXAMPLE_API_KEY',
  );
  assert.equal(valid.apiKeyEnv, 'EXAMPLE_API_KEY');
  assert.equal(valid.maxOutputTokens, 1024);
  for (const input of [
    { model: '' },
    { model: 'x', maxOutputTokens: 0 },
    { model: 'x', apiKeyEnv: 'HOME' },
    { model: 'x', apiKeyEnv: 'SECRET\nKEY' },
    { model: 'x', apiKey: 'inline' },
  ])
    assert.throws(() => validateProviderOptions(input, 'https://example.com'));
});

test('ordinary JSON transport rejects invalid UTF-8 instead of silently replacing bytes', async (t) => {
  const url = await server(t, (_req, res) =>
    res.end(
      Buffer.from([123, 34, 116, 101, 120, 116, 34, 58, 34, 255, 34, 125]),
    ),
  );
  await assert.rejects(requestJson({ ...options, url }), {
    code: 'invalid-response',
  });
});
