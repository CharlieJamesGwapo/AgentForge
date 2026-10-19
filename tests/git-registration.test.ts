import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '../src/core/config.js';
import { projectTools } from '../src/engines/project-tools.js';
import { prepareToolBatch } from '../src/engines/tools.js';
const names = ['git_status', 'git_diff', 'git_log', 'git_branch'];
test('Git tools are permission-gated and declarations/approval preparation do not execute Git', async () => {
  const config = structuredClone(defaultConfig);
  assert.ok(
    projectTools('/nonexistent-root', config).every(
      (tool) => !names.includes(tool.definition.name),
    ),
  );
  config.permissions.allowProcess = true;
  const tools = projectTools('/nonexistent-root', config);
  assert.deepEqual(
    names.filter((name) => tools.some((tool) => tool.definition.name === name)),
    names,
  );
  for (const name of names)
    assert.ok(
      tools.find((tool) => tool.definition.name === name)?.definition
        .resultSchema,
    );
  const batch = prepareToolBatch(tools, [
    { id: 'status', name: 'git_status', arguments: {} },
  ]);
  assert.match(JSON.stringify(batch.review), /git/i);
  await assert.rejects(
    batch.execute({ approved: false, approvalId: batch.approvalId }),
    { code: 'policy' },
  );
  await assert.rejects(batch.execute({ approved: true, approvalId: 'wrong' }), {
    code: 'policy',
  });
});
