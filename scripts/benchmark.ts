import assert from 'node:assert/strict';
import { compactPrompt } from '../src/engines/prompt.js';
const cases = [
  {
    name: 'duplicate prose',
    input: 'Inspect files\nInspect files\nKeep safety\n',
    expected: 'Inspect files\nKeep safety\n',
  },
  {
    name: 'unique constraints',
    input: 'Preserve API\nNever expose secrets\nRun tests',
    expected: 'Preserve API\nNever expose secrets\nRun tests',
  },
  {
    name: 'code fence',
    input: '```ts\na();\na();\n```\n',
    expected: '```ts\na();\na();\n```\n',
  },
  {
    name: 'multilingual',
    input: '保持约束\n保持约束\nPréserver les tests\n',
    expected: '保持约束\nPréserver les tests\n',
  },
];
console.log(
  JSON.stringify(
    cases.map(({ name, input, expected }) => {
      const result = compactPrompt(input);
      assert.equal(result.text, expected);
      return { name, ...result };
    }),
    null,
    2,
  ),
);
