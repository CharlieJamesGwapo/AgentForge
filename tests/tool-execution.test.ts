import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareToolBatch, runToolConversation } from '../src/engines/tools.js';
import type { RegisteredTool } from '../src/engines/tools.js';
import type { ToolSession } from '../src/adapters/types.js';
const definition = {
  name: 'echo',
  description: 'Echo',
  parameters: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  },
};
const call = { id: 'one', name: 'echo', arguments: { message: 'approved' } };
test('tool execution requires exact explicit batch approval, is single-use and snapshots calls/handlers', async () => {
  let effects = 0;
  const registry: RegisteredTool[] = [
    {
      definition,
      execute: async (args) => {
        effects++;
        return args;
      },
    },
  ];
  const calls = structuredClone([call]);
  const batch = prepareToolBatch(registry, calls);
  assert.equal(effects, 0);
  await assert.rejects(
    batch.execute({ approved: false, approvalId: batch.approvalId }),
    /approval/i,
  );
  await assert.rejects(
    batch.execute({ approved: true, approvalId: 'wrong' }),
    /approval/i,
  );
  calls[0]!.arguments.message = 'changed';
  registry[0]!.execute = async () => {
    throw new Error('changed handler');
  };
  assert.throws(() => {
    batch.calls[0]!.arguments.message = 'changed';
  });
  const results = await batch.execute({
    approved: true,
    approvalId: batch.approvalId,
  });
  assert.equal(effects, 1);
  assert.equal(JSON.parse(results[0]!.output).message, 'approved');
  await assert.rejects(
    batch.execute({ approved: true, approvalId: batch.approvalId }),
  );
  assert.notEqual(
    prepareToolBatch(registry, [call]).approvalId,
    batch.approvalId,
  );
});
test('all arguments validate before any effect and cancelled approval executes nothing', async () => {
  let effects = 0;
  const registry = [
    {
      definition,
      execute: async () => {
        effects++;
        return 'ok';
      },
    },
  ];
  assert.throws(() =>
    prepareToolBatch(registry, [call, { ...call, id: 'two', name: 'unknown' }]),
  );
  assert.equal(effects, 0);
  const batch = prepareToolBatch(registry, [call]);
  await assert.rejects(
    batch.execute({
      approved: true,
      approvalId: batch.approvalId,
      signal: AbortSignal.abort(),
    }),
  );
  assert.equal(effects, 0);
});
test('handler errors are sanitized results, limits enforced and cancelled batches stop', async () => {
  const registry = [
    {
      definition,
      execute: async () => {
        throw new Error('private handler details');
      },
    },
  ];
  const batch = prepareToolBatch(registry, [call]);
  const result = await batch.execute({
    approved: true,
    approvalId: batch.approvalId,
  });
  assert.equal(result[0]?.isError, true);
  assert.ok(!result[0]?.output.includes('private'));
  const big = prepareToolBatch(
    [{ definition, execute: async () => 'x'.repeat(70000) }],
    [call],
  );
  assert.equal(
    (await big.execute({ approved: true, approvalId: big.approvalId }))[0]
      ?.isError,
    true,
  );
});
test('conversation stops on denial without effects or follow-up and approves each new round separately', async () => {
  let effects = 0,
    requests = 0,
    approvals = 0;
  const tools = [
    {
      definition,
      execute: async () => {
        effects++;
        return 'ok';
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
        calls: [call],
        usage: { status: 'unavailable' },
      };
    },
  };
  const denied = await runToolConversation({
    session,
    tools,
    request: { approved: true, timeoutMs: 1000 },
    approve: async () => false,
  });
  assert.equal(denied.status, 'approval-required');
  assert.equal(effects, 0);
  assert.equal(requests, 1);
  requests = 0;
  const result = await runToolConversation({
    session,
    tools,
    request: { approved: true, timeoutMs: 1000 },
    approve: async () => {
      approvals++;
      return approvals === 1;
    },
  });
  assert.equal(result.status, 'approval-required');
  assert.equal(effects, 1);
  assert.equal(requests, 2);
  assert.equal(approvals, 2);
});

test('resolved effects containing secrets cannot be approved with hidden arguments', () => {
  assert.throws(
    () =>
      prepareToolBatch(
        [
          {
            definition,
            execute: async () => 'ok',
            review: () => ({ command: 'node', args: ['Bearer private-value'] }),
          },
        ],
        [call],
      ),
    /sensitive/i,
  );
});
test('tool deadline stops the batch and no subsequent handler starts', async () => {
  let effects = 0;
  let aborted = false;
  const batch = prepareToolBatch(
    [
      {
        definition,
        execute: async (_args, signal) => {
          effects++;
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            ),
          );
          return 'late';
        },
      },
    ],
    [call, { ...call, id: 'two' }],
  );
  await assert.rejects(
    batch.execute({
      approved: true,
      approvalId: batch.approvalId,
      timeoutMs: 5,
    }),
    /stopped|cancelled/i,
  );
  assert.equal(effects, 1);
  assert.equal(aborted, true);
});
