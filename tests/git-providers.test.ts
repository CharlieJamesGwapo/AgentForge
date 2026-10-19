import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { projectTools } from '../src/engines/project-tools.js';
import { runToolConversation } from '../src/engines/tools.js';
import { selectProvider } from '../src/adapters/registry.js';
import { sendToolReply, type Protocol } from './helpers/tool-protocol.js';
const calls = [
  { id: 'status', name: 'git_status', arguments: {} },
  {
    id: 'diff',
    name: 'git_diff',
    arguments: { path: 'note.txt', staged: false },
  },
  { id: 'log', name: 'git_log', arguments: { limit: 2 } },
  { id: 'branch', name: 'git_branch', arguments: {} },
];
for (const provider of ['openai', 'anthropic', 'ollama'] as Protocol[])
  for (const stream of [false, true])
    for (const approve of [false, true]) {
      test(`${provider} ${stream ? 'stream' : 'ordinary'} Git inspection ${approve ? 'approved' : 'denied'} preserves validated native continuation`, async (t) => {
        const root = await mkdtemp(
          path.join(tmpdir(), 'agentforge-git-providers-'),
        );
        t.after(() => rm(root, { recursive: true, force: true }));
        const git = (args: string[]) => {
          const result = spawnSync('git', ['-C', root, ...args], {
            encoding: 'utf8',
          });
          assert.equal(result.status, 0, result.stderr);
        };
        git(['init', '--quiet']);
        await writeFile(path.join(root, 'note.txt'), 'before\n');
        git(['add', '--', 'note.txt']);
        await writeFile(path.join(root, 'note.txt'), 'after xy\n');
        const config = structuredClone(defaultConfig);
        config.permissions.allowProcess = true;
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
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        );
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
            apiKeyEnv: 'GIT_FIXTURE_KEY',
          },
        ];
        const previous = process.env.GIT_FIXTURE_KEY;
        process.env.GIT_FIXTURE_KEY = 'xy';
        t.after(() => {
          if (previous === undefined) delete process.env.GIT_FIXTURE_KEY;
          else process.env.GIT_FIXTURE_KEY = previous;
        });
        const tools = projectTools(root, config),
          adapter = selectProvider(config, provider);
        const session = adapter.createToolSession!({
          prompt: 'Inspect repository',
          tools: tools.map((t) => t.definition),
          responseSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        });
        let approvals = 0;
        const result = await runToolConversation({
          session,
          tools,
          request: { approved: true, timeoutMs: 5000 },
          stream,
          approve: async (batch) => {
            approvals++;
            assert.equal(batch.calls.length, 4);
            return approve;
          },
          onResults: (results) => {
            assert.ok(results.every((r) => !r.isError));
            for (const r of results)
              assert.equal(JSON.parse(r.output).status, 'ok', r.output);
          },
        });
        assert.equal(approvals, 1);
        assert.equal(bodies.length, approve ? 2 : 1);
        assert.ok(
          bodies.every(
            (body) => !JSON.stringify(body.tools).includes('resultSchema'),
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
        const last = bodies[1]!,
          wire = JSON.stringify(
            provider === 'openai'
              ? (last.input as { type: string }[]).filter(
                  (item) => item.type === 'function_call_output',
                )
              : provider === 'anthropic'
                ? (last.messages as { content: unknown }[]).at(-1)!.content
                : (last.messages as { role: string }[]).filter(
                    (item) => item.role === 'tool',
                  ),
          );
        assert.match(wire, /note.txt/);
        assert.match(wire, /REDACTED/);
        assert.ok(!wire.includes('xy'));
      });
    }
