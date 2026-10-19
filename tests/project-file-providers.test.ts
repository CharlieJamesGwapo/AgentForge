import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../src/core/config.js';
import { projectTools } from '../src/engines/project-tools.js';
import { runToolConversation } from '../src/engines/tools.js';
import { selectProvider } from '../src/adapters/registry.js';
import { sendToolReply, type Protocol } from './helpers/tool-protocol.js';
const calls = [
  {
    id: 'search',
    name: 'project_search',
    arguments: {
      query: 'Needle',
      mode: 'content',
      directory: '.',
      maxResults: 10,
    },
  },
  {
    id: 'read',
    name: 'project_read',
    arguments: { path: 'src/note.txt', startLine: 1, lineCount: 2 },
  },
];
for (const provider of ['openai', 'anthropic', 'ollama'] as Protocol[])
  for (const stream of [false, true])
    for (const approve of [false, true]) {
      test(`${provider} ${stream ? 'stream' : 'ordinary'} project files ${approve ? 'approved' : 'denied'} with strict results and final schema`, async (t) => {
        const root = await mkdtemp(
          path.join(tmpdir(), 'agentforge-files-provider-'),
        );
        t.after(() => rm(root, { recursive: true, force: true }));
        await mkdir(path.join(root, 'src'));
        await writeFile(
          path.join(root, 'src/note.txt'),
          'Needle xy\npassword=hidden-fixture-value\n',
        );
        const config = structuredClone(defaultConfig);
        const bodies: Record<string, unknown>[] = [];
        const server = createServer((req, res) => {
          let raw = '';
          req.on('data', (c) => (raw += c));
          req.on('end', () => {
            const body = JSON.parse(raw);
            bodies.push(body);
            void sendToolReply(
              res,
              provider,
              bodies.length === 1 ? calls : [],
              stream,
            ).catch(() => res.destroy());
          });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        t.after(() => {
          server.closeAllConnections();
          server.close();
        });
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        config.providers = [
          {
            id: provider,
            model: 'fixture',
            baseUrl: `http://127.0.0.1:${address.port}${provider === 'ollama' ? '' : '/v1'}`,
            apiKeyEnv: 'FILE_FIXTURE_KEY',
          },
        ];
        const previous = process.env.FILE_FIXTURE_KEY;
        process.env.FILE_FIXTURE_KEY = 'xy';
        t.after(() => {
          if (previous === undefined) delete process.env.FILE_FIXTURE_KEY;
          else process.env.FILE_FIXTURE_KEY = previous;
        });
        const tools = projectTools(root, config);
        const adapter = selectProvider(config, provider);
        const responseSchema = {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        };
        const session = adapter.createToolSession!({
          prompt: 'Inspect',
          tools: tools.map((t) => t.definition),
          responseSchema,
        });
        let approvals = 0;
        const result = await runToolConversation({
          session,
          tools,
          request: { approved: true, timeoutMs: 3000 },
          stream,
          approve: async (batch) => {
            approvals++;
            assert.equal(batch.calls.length, 2);
            assert.match(JSON.stringify(batch.review), /shareWithProvider/);
            return approve;
          },
        });
        assert.equal(approvals, 1);
        assert.equal(bodies.length, approve ? 2 : 1);
        assert.ok(
          bodies.every(
            (b) => !JSON.stringify(b.tools).includes('resultSchema'),
          ),
        );
        if (!approve) {
          assert.equal(result.status, 'approval-required');
          return;
        }
        assert.equal(result.status, 'completed');
        assert.deepEqual(result.turn.structured, {
          status: 'valid',
          data: { answer: 'complete' },
        });
        const last = bodies[1]!;
        const wire = JSON.stringify(
          provider === 'openai'
            ? (last.input as { type: string }[]).filter(
                (i) => i.type === 'function_call_output',
              )
            : provider === 'anthropic'
              ? (last.messages as { content: unknown }[]).at(-1)!.content
              : (last.messages as { role: string }[]).filter(
                  (i) => i.role === 'tool',
                ),
        );
        assert.match(wire, /Needle/);
        assert.match(wire, /REDACTED/);
        assert.ok(!wire.includes('hidden-fixture-value'));
        assert.ok(!wire.includes('xy'));
        assert.match(wire, /note.txt/);
      });
    }
