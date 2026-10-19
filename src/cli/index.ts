#!/usr/bin/env node
import { CommanderError } from 'commander';
import { createProgram } from './program.js';
import { AgentForgeError } from '../shared/errors.js';
import { ProviderError } from '../adapters/errors.js';
import { redactValue } from '../shared/safety.js';

const controller = new AbortController();
const cancel = () => {
  controller.abort();
  process.exitCode = 5;
};
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const program = await createProgram(controller.signal);
  await program.parseAsync(process.argv);
  if (controller.signal.aborted) process.exitCode = 5;
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0)
    process.exitCode = 0;
  else {
    const code =
      error instanceof AgentForgeError
        ? error.exitCode
        : error instanceof CommanderError
          ? 2
          : 1;
    const message =
      error instanceof Error ? error.message : 'Unexpected failure';
    console.error(
      JSON.stringify(
        redactValue({
          error: message,
          ...(error instanceof ProviderError
            ? {
                providerError: error.code,
                ...(error.status ? { httpStatus: error.status } : {}),
              }
            : {}),
          exitCode: code,
          ...(process.argv.includes('--verbose')
            ? { category: error instanceof Error ? error.name : 'Error' }
            : {}),
        }),
        null,
        2,
      ),
    );
    process.exitCode = code;
  }
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
