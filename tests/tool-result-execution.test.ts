import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderError } from '../src/adapters/errors.js';
import type { ToolSession } from '../src/adapters/types.js';
import { defaultConfig } from '../src/core/config.js';
import { projectTools } from '../src/engines/project-tools.js';
import {
  prepareToolBatch,
  runToolConversation,
  type PendingToolBatch,
  type RegisteredTool,
} from '../src/engines/tools.js';

const resultSchema = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
};
const definition = {
  name: 'echo',
  description: 'Echo a value',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  resultSchema,
};
const call = { id: 'one', name: 'echo', arguments: {} };
const approved = (batch: PendingToolBatch) =>
  batch.execute({ approved: true, approvalId: batch.approvalId });

test('typed results remain inert until exact approval', async () => {
  let effects = 0;
  const registry: RegisteredTool[] = [
    {
      definition,
      execute: async () => {
        effects++;
        return { message: 'ready' };
      },
    },
  ];
  const batch = prepareToolBatch(registry, [call]);

  await assert.rejects(
    batch.execute({ approved: false, approvalId: batch.approvalId }),
    /approval/i,
  );
  await assert.rejects(
    batch.execute({ approved: true, approvalId: 'wrong' }),
    /approval/i,
  );
  assert.equal(effects, 0);
});

test('typed results accept and serialize every JSON root canonically', async () => {
  const roots: { schema: Record<string, unknown>; value: unknown }[] = [
    {
      schema: {
        type: 'object',
        properties: { ready: { type: 'boolean' } },
        required: ['ready'],
        additionalProperties: false,
      },
      value: { ready: true },
    },
    { schema: { type: 'array', items: { type: 'integer' } }, value: [1, 2] },
    { schema: { type: 'string' }, value: 'ready' },
    { schema: { type: 'integer' }, value: 2 },
    { schema: { type: 'number' }, value: 2.5 },
    { schema: { type: 'boolean' }, value: false },
    { schema: { type: 'null' }, value: null },
  ];

  for (const { schema, value } of roots) {
    const batch = prepareToolBatch(
      [
        {
          definition: { ...definition, resultSchema: schema },
          execute: async () => value,
        },
      ],
      [call],
    );
    const [result] = await approved(batch);
    assert.equal(result?.isError, undefined);
    assert.equal(result?.output, JSON.stringify(value));
  }
});

test('a batch snapshots result contracts and exposes only a frozen review copy', async () => {
  const mutableSchema = structuredClone(resultSchema);
  const registry: RegisteredTool[] = [
    {
      definition: { ...definition, resultSchema: mutableSchema },
      execute: async () => ({ message: 'ready' }),
      review: () => {
        mutableSchema.properties.message.type = 'integer';
        registry[0]!.execute = async () => ({ message: 42 });
        return null;
      },
    },
  ];
  const batch = prepareToolBatch(registry, [call]);
  const contract = (batch.review[0] as { resultSchema: typeof resultSchema })
    .resultSchema;
  assert.deepEqual(contract, resultSchema);
  assert.throws(() => {
    contract.properties.message.type = 'integer';
  });

  mutableSchema.properties.message.type = 'integer';
  registry[0]!.definition.resultSchema = {
    type: 'string',
  };
  registry[0]!.execute = async () => ({ message: 'changed' });
  assert.deepEqual(contract, resultSchema);
  const [result] = await approved(batch);
  assert.equal(result?.output, '{"message":"ready"}');
  assert.equal(result?.isError, undefined);
});

test('a raw result schema failure stops the batch, follow-up and re-use', async () => {
  let executions = 0;
  let requests = 0;
  let captured: PendingToolBatch | undefined;
  const tools: RegisteredTool[] = [
    {
      definition,
      execute: async () => {
        executions++;
        return executions === 1 ? { message: 7 } : { message: 'valid' };
      },
    },
  ];
  const session: ToolSession = {
    next: async () => {
      requests++;
      return {
        text: '',
        model: 'fixture',
        finishReason: 'tool-calls',
        calls: [call, { ...call, id: 'two' }],
        usage: { status: 'unavailable' },
      };
    },
  };

  await assert.rejects(
    runToolConversation({
      session,
      tools,
      request: { approved: true, timeoutMs: 1000 },
      approve: async (batch) => {
        captured = batch;
        return true;
      },
    }),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === 'validation' &&
      error.exitCode === 4,
  );
  assert.equal(executions, 1);
  assert.equal(requests, 1);
  assert.ok(captured);
  await assert.rejects(
    approved(captured),
    (error: unknown) =>
      error instanceof ProviderError && error.code === 'policy',
  );
  assert.equal(executions, 1);
});

test('a redacted typed value that violates its enum is withheld as validation failure', async () => {
  const environmentName = 'AGENTFORGE_TOOL_RESULT_TEST_SECRET';
  const previousValue = process.env[environmentName];
  const sensitiveValue = 'sensitive-result-fixture';
  const batch = prepareToolBatch(
    [
      {
        definition: {
          ...definition,
          resultSchema: {
            type: 'object',
            properties: { value: { type: 'string', enum: [sensitiveValue] } },
            required: ['value'],
            additionalProperties: false,
          },
        },
        execute: async () => ({ value: sensitiveValue }),
      },
    ],
    [call],
  );

  process.env[environmentName] = sensitiveValue;
  try {
    await assert.rejects(
      approved(batch),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === 'validation' &&
        error.exitCode === 4 &&
        !error.message.includes(sensitiveValue),
    );
  } finally {
    if (previousValue === undefined) delete process.env[environmentName];
    else process.env[environmentName] = previousValue;
  }
});

test('handler exceptions stay generic error results and later approved calls can run', async () => {
  let executions = 0;
  const batch = prepareToolBatch(
    [
      {
        definition,
        execute: async () => {
          executions++;
          if (executions === 1) throw new Error('private handler detail');
          return { message: 'ready' };
        },
      },
    ],
    [call, { ...call, id: 'two' }],
  );

  const results = await approved(batch);
  assert.deepEqual(results, [
    {
      callId: 'one',
      output: 'Tool failed or result exceeded limits. Details omitted.',
      isError: true,
    },
    { callId: 'two', output: '{"message":"ready"}' },
  ]);
  assert.equal(executions, 2);
});

test('default project tool result schemas validate actual summary and check outputs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-tool-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.2.3',
      scripts: { test: 'private' },
    }),
  );
  const config = structuredClone(defaultConfig);
  config.project = 'fixture project';
  config.permissions.allowProcess = true;
  config.verification.checks = [
    {
      name: 'fixture',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
    },
  ];
  const tools = projectTools(root, config);
  const summary = tools.find(
    (tool) => tool.definition.name === 'project_summary',
  )!;
  const check = tools.find(
    (tool) => tool.definition.name === 'verification_check',
  )!;
  assert.deepEqual(summary.definition.resultSchema, {
    type: 'object',
    properties: {
      project: { type: 'string' },
      package: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'] },
          version: { type: ['string', 'null'] },
          scripts: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'version', 'scripts'],
        additionalProperties: false,
      },
    },
    required: ['project', 'package'],
    additionalProperties: false,
  });
  assert.deepEqual(check.definition.resultSchema, {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        status: {
          type: 'string',
          enum: [
            'passed',
            'failed',
            'timed-out',
            'cancelled',
            'unavailable',
            'output-limit',
          ],
        },
        exitCode: { type: ['integer', 'null'] },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        durationMs: { type: 'number' },
      },
      required: [
        'name',
        'status',
        'exitCode',
        'stdout',
        'stderr',
        'durationMs',
      ],
      additionalProperties: false,
    },
  });

  const summaryBatch = prepareToolBatch(
    [summary],
    [{ id: 'summary', name: 'project_summary', arguments: {} }],
  );
  const [summaryResult] = await approved(summaryBatch);
  assert.equal(summaryResult?.isError, undefined);
  assert.deepEqual(JSON.parse(summaryResult!.output), {
    project: 'fixture project',
    package: { name: 'fixture', version: '1.2.3', scripts: ['test'] },
  });

  const checkBatch = prepareToolBatch(
    [check],
    [
      {
        id: 'check',
        name: 'verification_check',
        arguments: { name: 'fixture' },
      },
    ],
  );
  const [checkResult] = await approved(checkBatch);
  assert.equal(checkResult?.isError, undefined);
  const [actualCheck] = JSON.parse(checkResult!.output) as {
    name: string;
    status: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
  }[];
  assert.deepEqual(
    {
      name: actualCheck?.name,
      status: actualCheck?.status,
      exitCode: actualCheck?.exitCode,
      stdout: actualCheck?.stdout,
      stderr: actualCheck?.stderr,
    },
    {
      name: 'fixture',
      status: 'passed',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    },
  );
  assert.equal(typeof actualCheck?.durationMs, 'number');
});

test('result schema metadata may name credential fields without being mistaken for secret data', async () => {
  const batch = prepareToolBatch(
    [
      {
        definition: {
          ...definition,
          resultSchema: {
            type: 'object',
            properties: { token: { type: 'string', enum: ['[REDACTED]'] } },
            required: ['token'],
            additionalProperties: false,
          },
        },
        execute: async () => ({ token: '[REDACTED]' }),
      },
    ],
    [call],
  );
  assert.equal((await approved(batch))[0]?.output, '{"token":"[REDACTED]"}');
});

test('literal sensitive content in result schema metadata is withheld from approval', () => {
  const privateValue = 'sk-fixturecredential123456';
  assert.throws(
    () =>
      prepareToolBatch(
        [
          {
            definition: {
              ...definition,
              resultSchema: { type: 'string', description: privateValue },
            },
            execute: async () => '',
          },
        ],
        [call],
      ),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === 'policy' &&
      !error.message.includes(privateValue),
  );
});
