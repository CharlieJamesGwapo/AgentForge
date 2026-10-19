import assert from 'node:assert/strict';
import test from 'node:test';
import { compactPrompt, refinePrompt } from '../src/engines/prompt.js';

test('refinePrompt preserves the request and gives it an actionable, bounded structure', () => {
  const request =
    'Add a rate limiter to the API without changing existing response formats.';
  const result = refinePrompt(request);

  assert.ok(result.prompt.includes(request));
  for (const section of [
    'Objective',
    'Context',
    'Scope',
    'Constraints',
    'Implementation plan',
    'Acceptance criteria',
    'Testing plan',
    'Risks',
    'Unresolved questions',
  ]) {
    assert.ok(result.prompt.includes(section), `missing ${section} section`);
  }
  assert.ok(Array.isArray(result.assumptions));
  assert.ok(
    result.assumptions.every((assumption) => assumption.trim().length > 0),
  );
});

test('compactPrompt removes only exact adjacent duplicates outside fenced code', () => {
  const input = [
    'Keep this requirement.',
    'Keep this requirement.',
    '  Keep this requirement.',
    '```ts',
    'const keep = true;',
    'const keep = true;',
    '```',
    'Verify behavior.',
    'Verify behavior.',
  ].join('\n');

  const result = compactPrompt(input);

  assert.equal(
    result.text,
    [
      'Keep this requirement.',
      '  Keep this requirement.',
      '```ts',
      'const keep = true;',
      'const keep = true;',
      '```',
      'Verify behavior.',
    ].join('\n') + '\n',
  );
  assert.equal(result.removedLines, 2);
  assert.equal(result.originalCharacters, input.length);
  assert.equal(result.optimizedCharacters, result.text.length);
  assert.equal(result.originalTokenEstimate, Math.ceil(input.length / 4));
  assert.equal(
    result.optimizedTokenEstimate,
    Math.ceil(result.text.length / 4),
  );
  assert.match(result.method, /estimate/i);
});

test('compactPrompt preserves distinct lines without a final newline and counts Unicode code points', () => {
  const input = 'First line.\n😀';
  const result = compactPrompt(input);

  assert.equal(result.text, input);
  assert.equal(result.originalCharacters, 13);
  assert.equal(result.optimizedCharacters, 13);
  assert.equal(result.originalTokenEstimate, 4);
});
