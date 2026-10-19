import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../core/config.js';
import { readJson } from '../core/storage.js';
import { prepareSchema } from '../adapters/output.js';
import { selectProvider } from '../adapters/registry.js';
import { ProviderError } from '../adapters/errors.js';
import { AgentForgeError } from '../shared/errors.js';
import { redactValue } from '../shared/safety.js';
import { applyResultSchemas } from './tool-result-schemas.js';
import { projectTools } from '../engines/project-tools.js';
import { runToolConversation } from '../engines/tools.js';
export function registerToolCommands(
  program: Command,
  root: () => Promise<string>,
  signal: AbortSignal,
): void {
  const tools = program
    .command('tools')
    .description(
      'Request client function calls and approve exact batches before execution',
    );
  tools
    .command('list')
    .description(
      'List available fixed project tools without network or execution',
    )
    .action(async () => {
      const directory = await root();
      const config = await loadConfig(directory);
      console.log(
        JSON.stringify(
          redactValue({
            tools: projectTools(directory, config).map(
              (tool) => tool.definition,
            ),
          }),
          null,
          2,
        ),
      );
    });
  tools
    .command('run')
    .description(
      'Run a bounded tool conversation; every execution batch requires interactive approval',
    )
    .requiredOption(
      '--task <text>',
      'explicit task sent to the selected provider',
    )
    .requiredOption('--provider <id>', 'explicitly configured provider id')
    .option(
      '--approve-network',
      'approve this conversation, including sending approved tool results',
    )
    .option(
      '--execute',
      'ask for each batch approval on a terminal (also requires permissions.allowTools)',
    )
    .option('--max-turns <count>', 'maximum network turns, 1–10', '6')
    .option(
      '--stream',
      'stream sanitized text; tool calls remain inert until terminal validation',
    )
    .option(
      '--schema <relative-file>',
      'validate the final answer against a portable JSON schema',
    )
    .option(
      '--result-schemas <relative-file>',
      'apply local tool-name to result-schema overrides before requesting tools',
    )
    .option(
      '--timeout-ms <ms>',
      'deadline per network request, 1–300000',
      '60000',
    )
    .action(
      async (options: {
        task: string;
        provider: string;
        approveNetwork?: boolean;
        execute?: boolean;
        stream?: boolean;
        schema?: string;
        resultSchemas?: string;
        maxTurns: string;
        timeoutMs: string;
      }) => {
        const directory = await root();
        const config = await loadConfig(directory);
        if (!config.permissions.allowNetwork || !options.approveNetwork)
          throw new ProviderError(
            'policy',
            'Network use requires permissions.allowNetwork=true and --approve-network.',
          );
        if (options.execute && !config.permissions.allowTools)
          throw new ProviderError(
            'policy',
            'Tool execution requires permissions.allowTools=true, --execute and exact interactive batch approval.',
          );
        const timeoutMs = Number(options.timeoutMs),
          maxTurns = Number(options.maxTurns);
        if (
          !Number.isInteger(timeoutMs) ||
          timeoutMs < 1 ||
          timeoutMs > 300000 ||
          !Number.isInteger(maxTurns) ||
          maxTurns < 1 ||
          maxTurns > 10
        )
          throw new AgentForgeError('Invalid tool conversation limits.', 2);
        const provider = selectProvider(config, options.provider);
        if (!provider.createToolSession)
          throw new ProviderError(
            'unavailable',
            'Selected provider does not implement client function calls.',
          );
        const available = projectTools(directory, config);
        const registry =
          options.resultSchemas === undefined
            ? available
            : applyResultSchemas(
                available,
                await readJson(directory, options.resultSchemas),
              );
        const responseSchema =
          options.schema === undefined
            ? undefined
            : prepareSchema(await readJson(directory, options.schema));
        const session = provider.createToolSession({
          prompt: options.task,
          tools: registry.map((tool) => tool.definition),
          maxTurns,
          ...(responseSchema === undefined ? {} : { responseSchema }),
        });
        const emit = (value: unknown) => console.log(JSON.stringify(value));
        const result = await runToolConversation({
          session,
          tools: registry,
          request: { approved: true, timeoutMs, signal },
          stream: options.stream,
          onEvent: (event) => {
            if (event.type === 'text-delta')
              emit({ provider: provider.id, ...event });
          },
          executionTimeoutMs: config.verification.timeoutMs,
          onTurn: (turn) =>
            emit({ type: 'tool-turn', provider: provider.id, ...turn }),
          onResults: (results) =>
            emit({
              type: 'tool-results',
              results: results.map(({ callId, isError }) => ({
                callId,
                status: isError ? 'error' : 'returned',
              })),
            }),
          approve: async (batch) => {
            emit({
              type: 'approval-required',
              approvalId: batch.approvalId,
              calls: batch.calls,
              review: batch.review,
              disclosure:
                'Approved tool results will be sent to this provider.',
            });
            if (
              !options.execute ||
              !process.stdin.isTTY ||
              !process.stderr.isTTY
            )
              return false;
            const terminal = createInterface({
              input: process.stdin,
              output: process.stderr,
            });
            try {
              return (
                (await terminal.question(
                  `Type approve ${batch.approvalId} to execute this batch and share results, or press Enter to decline: `,
                  { signal },
                )) === `approve ${batch.approvalId}`
              );
            } catch (error) {
              if (
                signal.aborted ||
                (error instanceof Error && error.name === 'AbortError')
              )
                throw new ProviderError(
                  'cancelled',
                  'Tool approval cancelled.',
                );
              throw error;
            } finally {
              terminal.close();
            }
          },
        });
        emit({ type: 'tool-conversation', ...result });
        if (result.status === 'approval-required') process.exitCode = 6;
        else if (result.turn.finishReason !== 'completed') process.exitCode = 4;
      },
    );
}
