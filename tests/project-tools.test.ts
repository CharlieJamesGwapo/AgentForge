import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../src/core/config.js';
import { projectTools } from '../src/engines/project-tools.js';
import { prepareToolBatch } from '../src/engines/tools.js';
import { createToolSession } from '../src/adapters/tools.js';
import { runToolConversation } from '../src/engines/tools.js';
test('project verification effects require approval and preserve fixed config argv against mutation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-project-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = structuredClone(defaultConfig);
  config.verification.checks = [
    {
      name: 'fixture',
      command: process.execPath,
      args: [
        '-e',
        'require("node:fs").writeFileSync("marker",process.argv[1])',
        'literal;$(no-shell)',
      ],
    },
  ];
  assert.ok(
    !projectTools(root, config).some(
      (tool) => tool.definition.name === 'verification_check',
    ),
  );
  config.permissions.allowProcess = true;
  const registry = projectTools(root, config);
  const verification = registry.find(
    (tool) => tool.definition.name === 'verification_check',
  )!;
  const exposed = verification.review!({ name: 'fixture' }) as {
    check: { args: string[] };
  };
  const batch = prepareToolBatch(registry, [
    { id: 'one', name: 'verification_check', arguments: { name: 'fixture' } },
  ]);
  config.verification.checks[0]!.args[1] = 'throw new Error("mutated config")';
  exposed.check.args[1] =
    'require("node:fs").writeFileSync("marker","changed-after-review")';
  await assert.rejects(
    batch.execute({ approved: false, approvalId: batch.approvalId }),
  );
  await assert.rejects(stat(path.join(root, 'marker')));
  const result = await batch.execute({
    approved: true,
    approvalId: batch.approvalId,
  });
  assert.equal(result[0]?.isError, undefined);
  assert.equal(
    await readFile(path.join(root, 'marker'), 'utf8'),
    'literal;$(no-shell)',
  );
});
test('project summary reports only selected package fields', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-project-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '0.0.0',
      scripts: { test: 'private script contents' },
      privateValue: 'never-share',
    }),
  );
  const registry = projectTools(root, structuredClone(defaultConfig));
  const batch = prepareToolBatch(registry, [
    { id: 'one', name: 'project_summary', arguments: {} },
  ]);
  const result = await batch.execute({
    approved: true,
    approvalId: batch.approvalId,
  });
  assert.deepEqual(JSON.parse(result[0]!.output), {
    project: 'project',
    package: { name: 'fixture', version: '0.0.0', scripts: ['test'] },
  });
});
test('last permitted network turn cannot cause an orphaned tool effect', async () => {
  let effects = 0;
  const definition = {
    name: 'echo',
    description: 'Echo',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };
  const session = createToolSession(
    { prompt: 'x', tools: [definition], maxTurns: 1 },
    {
      initial: () => [],
      request: async () => ({}),
      append: () => [],
      parse: () => ({
        turn: {
          text: '',
          model: 'fixture',
          finishReason: 'tool-calls',
          calls: [{ id: 'one', name: 'echo', arguments: {} }],
          usage: { status: 'unavailable' },
        },
        continuation: [],
      }),
    },
  );
  await assert.rejects(
    runToolConversation({
      session,
      tools: [
        {
          definition,
          execute: async () => {
            effects++;
            return 'effect';
          },
        },
      ],
      request: { approved: true, timeoutMs: 1000 },
      approve: async () => true,
    }),
    /limit/i,
  );
  assert.equal(effects, 0);
});
