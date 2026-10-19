import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { projectTools } from '../src/engines/project-tools.js';
import { prepareToolBatch } from '../src/engines/tools.js';
import { validateToolResult } from '../src/adapters/tool-results.js';
const readArgs = { path: 'src/note.txt', startLine: 2, lineCount: 2 };
const searchArgs = {
  query: 'Needle',
  mode: 'content',
  directory: '.',
  maxResults: 10,
};
test('project file declarations and approval review stay offline until exact approval', async () => {
  const registry = projectTools(
    '/nonexistent-agentforge-test-root',
    structuredClone(defaultConfig),
  );
  const batch = prepareToolBatch(registry, [
    { id: 'read', name: 'project_read', arguments: readArgs },
    { id: 'search', name: 'project_search', arguments: searchArgs },
  ]);
  assert.equal(batch.calls.length, 2);
  assert.match(JSON.stringify(batch.review), /shareWithProvider/);
  assert.match(JSON.stringify(batch.review), /src\/note.txt/);
  assert.match(JSON.stringify(batch.review), /Needle/);
  await assert.rejects(
    batch.execute({ approved: false, approvalId: batch.approvalId }),
    { code: 'policy' },
  );
  await assert.rejects(batch.execute({ approved: true, approvalId: 'wrong' }), {
    code: 'policy',
  });
});
test('file tool argument contracts reject invalid and unsafe actions before approval', () => {
  const registry = projectTools(
    '/nonexistent-agentforge-test-root',
    structuredClone(defaultConfig),
  );
  for (const args of [
    { ...readArgs, path: '../outside' },
    { ...readArgs, path: '.env' },
    { ...readArgs, lineCount: 201 },
    { ...readArgs, startLine: 0 },
    { ...readArgs, extra: true },
    { ...readArgs, path: 'a\\b' },
    { ...readArgs, startLine: '2' },
  ])
    assert.throws(() =>
      prepareToolBatch(registry, [
        { id: 'read', name: 'project_read', arguments: args },
      ]),
    );
  for (const args of [
    { ...searchArgs, query: '' },
    { ...searchArgs, query: 'a\nb' },
    { ...searchArgs, mode: 'regex' },
    { ...searchArgs, directory: '../outside' },
    { ...searchArgs, maxResults: 101 },
    { ...searchArgs, maxResults: '10' },
    { ...searchArgs, query: 'x'.repeat(201) },
  ])
    assert.throws(() =>
      prepareToolBatch(registry, [
        { id: 'search', name: 'project_search', arguments: args },
      ]),
    );
});
test('approved file tools return useful schema-valid results, redact content and cannot reuse approval', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-file-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'src/note.txt'),
    'first\nNeedle here\npassword=private-fixture-value\nlast\n',
  );
  const registry = projectTools(root, structuredClone(defaultConfig));
  const batch = prepareToolBatch(registry, [
    { id: 'read', name: 'project_read', arguments: readArgs },
    { id: 'search', name: 'project_search', arguments: searchArgs },
  ]);
  const results = await batch.execute({
    approved: true,
    approvalId: batch.approvalId,
  });
  assert.ok(results.every((r) => !r.isError));
  const read = JSON.parse(results[0]!.output);
  assert.equal(read.path, 'src/note.txt');
  assert.equal(read.lines[0].text, 'Needle here');
  assert.match(read.lines[1].text, /REDACTED/);
  assert.ok(!JSON.stringify(results).includes('private-fixture-value'));
  const search = JSON.parse(results[1]!.output);
  assert.deepEqual(search.matches, [
    { path: 'src/note.txt', line: 2, text: 'Needle here' },
  ]);
  for (const result of results) {
    const name = result.callId === 'read' ? 'project_read' : 'project_search';
    assert.equal(
      validateToolResult(
        result,
        registry.find((t) => t.definition.name === name)!.definition
          .resultSchema,
      ).output,
      result.output,
    );
  }
  await assert.rejects(
    batch.execute({ approved: true, approvalId: batch.approvalId }),
    { code: 'policy' },
  );
});
