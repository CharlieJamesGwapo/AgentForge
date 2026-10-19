import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig, validateConfig } from '../src/core/config.js';
test('old configuration loads with file writes disabled and cannot grant nonboolean write permission', () => {
  const old = JSON.parse(JSON.stringify(defaultConfig));
  delete old.permissions.allowWrite;
  const config = validateConfig(old);
  assert.equal(
    (config.permissions as Record<string, unknown>).allowWrite,
    false,
  );
  assert.throws(() =>
    validateConfig({
      ...old,
      permissions: { ...old.permissions, allowWrite: 'yes' },
    }),
  );
});

test('orchestration is additive, disabled by default, bounded to two workers and uses explicit neutral roles', () => {
  const old = JSON.parse(JSON.stringify(defaultConfig));
  delete old.orchestration;
  const config = validateConfig(old);
  assert.equal(config.orchestration.enabled, false);
  assert.equal(config.orchestration.maxConcurrency, 2);
  assert.equal(config.orchestration.planner, null);
  assert.equal(config.orchestration.executor, null);
  for (const changes of [
    { maxConcurrency: 3 },
    { maxConcurrency: 0 },
    { maxDepth: 2 },
    { maxSubtasks: 9 },
    { maxContextBytes: 0 },
    { maxOutputBytes: 65537 },
    { timeoutMs: 300001 },
    { maxDurationMs: 600001 },
    { planner: { provider: 'ollama', model: '' } },
    { executor: { provider: 'ollama', allowTools: true } },
  ])
    assert.throws(() =>
      validateConfig({
        ...old,
        orchestration: { ...config.orchestration, ...changes },
      }),
    );
  const neutral = validateConfig({
    ...old,
    orchestration: {
      ...config.orchestration,
      planner: { provider: 'future-adapter', model: 'chosen-model' },
    },
  });
  assert.equal(neutral.orchestration.planner?.provider, 'future-adapter');
});
