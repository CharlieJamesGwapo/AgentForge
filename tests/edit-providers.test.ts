import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { projectTools } from '../src/engines/project-tools.js';
import { runToolConversation } from '../src/engines/tools.js';
import { selectProvider } from '../src/adapters/registry.js';
import { sendToolReply, type Protocol } from './helpers/tool-protocol.js';

for (const provider of ['openai', 'anthropic', 'ollama'] as Protocol[])
  for (const stream of [false, true])
    for (const approvals of [0, 1, 2]) {
      test(`${provider} ${stream ? 'stream' : 'ordinary'} edit preview/apply with ${approvals} approvals keeps source unchanged`, async (t) => {
        const root = await mkdtemp(
          path.join(tmpdir(), 'agentforge-edit-providers-'),
        );
        t.after(() => rm(root, { recursive: true, force: true }));
        const target = path.join(root, 'note.txt');
        await writeFile(target, 'before\n');
        let requests = 0,
          proposalId: string | undefined;
        const server = createServer((req, res) => {
          let raw = '';
          req.on('data', (chunk) => (raw += chunk));
          req.on('end', () => {
            requests++;
            const body = JSON.parse(raw);
            assert.ok(!JSON.stringify(body.tools).includes('resultSchema'));
            const calls =
              requests === 1
                ? [
                    {
                      id: 'replace',
                      name: 'project_edit_replace',
                      arguments: {
                        path: 'note.txt',
                        oldText: 'before',
                        newText: 'after',
                      },
                    },
                  ]
                : requests === 2
                  ? [
                      {
                        id: 'apply',
                        name: 'project_edit_apply',
                        arguments: { proposalId },
                      },
                    ]
                  : [];
            void sendToolReply(res, provider, calls, stream).catch(() =>
              res.destroy(),
            );
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
        const config = structuredClone(defaultConfig);
        config.permissions.allowWrite = true;
        config.providers = [
          {
            id: provider,
            model: 'fixture',
            baseUrl: `http://127.0.0.1:${address.port}${provider === 'ollama' ? '' : '/v1'}`,
            apiKeyEnv: 'EDIT_FIXTURE_KEY',
          },
        ];
        const previous = process.env.EDIT_FIXTURE_KEY;
        process.env.EDIT_FIXTURE_KEY = 'local-edit-fixture';
        t.after(() => {
          if (previous === undefined) delete process.env.EDIT_FIXTURE_KEY;
          else process.env.EDIT_FIXTURE_KEY = previous;
        });
        const tools = projectTools(root, config);
        const session = selectProvider(config, provider).createToolSession!({
          prompt: 'Preview and request application',
          tools: tools.map((tool) => tool.definition),
          responseSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        });
        let asked = 0;
        const ids = new Set<string>();
        const statuses: string[] = [];
        const result = await runToolConversation({
          session,
          tools,
          stream,
          request: { approved: true, timeoutMs: 5000 },
          approve: async (batch) => {
            asked++;
            assert.ok(!ids.has(batch.approvalId));
            ids.add(batch.approvalId);
            if (asked === 2) {
              assert.ok(proposalId);
              const review = JSON.stringify(batch.review);
              assert.match(review, /before/);
              assert.match(review, /after/);
              assert.match(review, new RegExp(proposalId));
            }
            return asked <= approvals;
          },
          onResults: (results) => {
            for (const entry of results) {
              assert.equal(entry.isError, undefined, entry.output);
              const value = JSON.parse(entry.output);
              statuses.push(value.status);
              if (value.status === 'preview') proposalId = value.proposalId;
            }
          },
        });
        assert.equal(asked, approvals < 2 ? approvals + 1 : 2);
        assert.equal(requests, approvals + 1);
        assert.deepEqual(
          statuses,
          approvals === 0
            ? []
            : approvals === 1
              ? ['preview']
              : ['preview', 'unavailable'],
        );
        assert.equal(
          result.status,
          approvals === 2 ? 'completed' : 'approval-required',
        );
        if (approvals === 2)
          assert.deepEqual(result.turn.structured, {
            status: 'valid',
            data: { answer: 'complete' },
          });
        assert.equal(await readFile(target, 'utf8'), 'before\n');
      });
    }
