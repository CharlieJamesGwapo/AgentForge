import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  initProject,
  loadConfig,
  getConfig,
  setConfig,
} from '../core/config.js';
import type { Config } from '../core/config.js';
import {
  saveCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  loadCurrentContext,
} from '../core/context.js';
import { readJson } from '../core/storage.js';
import {
  doctor,
  projectRoot,
  projectStatus,
  skillRoots,
  packageRoot,
} from '../core/project.js';
import {
  discoverSkills,
  inspectSkill,
  validateSkills,
} from '../engines/skills.js';
import { compactPrompt, refinePrompt } from '../engines/prompt.js';
import { scanRepository } from '../engines/graph.js';
import { runChecks, runWorkflow } from '../engines/verification.js';
import { AgentForgeError } from '../shared/errors.js';
import { redactValue } from '../shared/safety.js';
import { prepareSchema } from '../adapters/output.js';
import {
  configuredProviderCredentials,
  selectProvider,
  providerReports,
} from '../adapters/registry.js';
import { registerToolCommands } from './tools.js';
import { registerTaskCommand } from './task.js';
import { registerGitCommands } from './git.js';
import { registerEditCommands } from './edit.js';
import { registerOrchestrationCommands } from './orchestrate.js';

export async function createProgram(signal: AbortSignal): Promise<Command> {
  const metadata = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { version: string };
  const program = new Command()
    .name('agentforge')
    .description(
      'Provider-neutral local developer workflows and portable skills',
    )
    .version(metadata.version)
    .option('--cwd <directory>', 'project directory', process.cwd())
    .option('--json', 'machine-readable JSON output')
    .option('--verbose', 'include diagnostic error categories')
    .exitOverride()
    .configureOutput({ writeErr: () => {}, outputError: () => {} });
  const root = () => projectRoot(program.opts<{ cwd: string }>().cwd);
  registerToolCommands(program, root, signal);
  registerTaskCommand(program, root, signal);
  registerGitCommands(program, root, signal);
  registerEditCommands(program, root, signal);
  registerOrchestrationCommands(program, root, signal);
  const print = (value: unknown, sensitiveValues: readonly string[] = []) => {
    const safe = redactValue(value, sensitiveValues);
    console.log(JSON.stringify(safe, null, 2));
  };
  const printConfig = (config: Config) =>
    print(
      config,
      configuredProviderCredentials(
        config,
        config.providers.map(({ id }) => id),
      ),
    );
  program.addHelpText(
    'after',
    '\nExamples:\n  agentforge init\n  agentforge status\n  agentforge provider list\n  agentforge skill list\n  agentforge tools list\n  agentforge git status\n  agentforge edit capabilities\n  agentforge orchestrate status\n  agentforge prompt --task "Fix parser"\n  agentforge context save --name parser --objective "Fix parser"\n  agentforge verify\n  agentforge verify --execute --approve\n  agentforge task --provider ollama --task "Inspect parser" --approve-network --stream\n\nVerification execution requires permissions.allowProcess=true plus --execute --approve.\nTool execution requires permissions.allowTools=true, --execute, and each exact batch ID typed at a terminal. Model requests also require permissions.allowNetwork=true and --approve-network.\nCommands return structured reports; --json guarantees the JSON interface.',
  );
  program.action(() => {
    program.outputHelp();
  });
  program
    .command('init')
    .description('Create configuration without overwriting existing settings')
    .action(async () => {
      const result = await initProject(await root());
      print(
        result,
        configuredProviderCredentials(
          result.config,
          result.config.providers.map(({ id }) => id),
        ),
      );
    });
  program
    .command('doctor')
    .description(
      'Check runtime, project permissions, configuration and optional capabilities',
    )
    .action(async () => {
      const result = await doctor(await root());
      print(result);
      if (!result.healthy) process.exitCode = 2;
    });
  program
    .command('status')
    .description('Inspect configured project, skills, checkpoints and adapters')
    .action(async () => {
      const status = await projectStatus(await root());
      print(
        status,
        configuredProviderCredentials(
          status.config,
          status.config.providers.map(({ id }) => id),
        ),
      );
    });
  const config = program
    .command('config')
    .description('Inspect and edit strict schema-validated configuration')
    .action(async () => printConfig(await loadConfig(await root())));
  config
    .command('get <key>')
    .description('Read a setting using a dotted key')
    .action(async (key: string) => {
      const current = await loadConfig(await root());
      print(
        { key, value: getConfig(current, key) },
        configuredProviderCredentials(
          current,
          current.providers.map(({ id }) => id),
        ),
      );
    });
  config
    .command('set <key> <value>')
    .description(
      'Set a setting (JSON objects/arrays/booleans/numbers, or a plain string)',
    )
    .action(async (key: string, value: string) => {
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {
        /* plain strings are valid values */
      }
      printConfig(await setConfig(await root(), key, parsed));
    });
  const skill = program
    .command('skill')
    .description(
      'Discover, inspect and validate inert portable skill definitions',
    );
  const roots = async () => {
    const directory = await root();
    let config;
    const existing = await readJson(directory, 'agentforge.config.json');
    if (existing !== undefined) config = await loadConfig(directory);
    return skillRoots(directory, config);
  };
  skill
    .command('list')
    .description('List bundled and project skills')
    .action(async () =>
      print({
        skills: (await discoverSkills(await roots())).map(
          ({ id, name, summary, capabilities }) => ({
            id,
            name,
            summary,
            capabilities,
          }),
        ),
      }),
    );
  skill
    .command('inspect <id>')
    .description('Show skill instructions, examples and acceptance criteria')
    .action(async (id: string) => print(await inspectSkill(await roots(), id)));
  skill
    .command('validate')
    .description(
      'Validate all discovered definitions; never execute skill content',
    )
    .action(async () => {
      const report = await validateSkills(await roots());
      print(report);
      if (!report.valid) process.exitCode = 2;
    });
  const context = program
    .command('context')
    .description('Inspect current local context and available checkpoints')
    .action(async () => {
      const directory = await root();
      await loadConfig(directory);
      print({
        current: await loadCurrentContext(directory),
        checkpoints: await listCheckpoints(directory),
      });
    });
  context
    .command('list')
    .description('List saved checkpoints')
    .action(async () =>
      print({ checkpoints: await listCheckpoints(await root()) }),
    );
  context
    .command('save')
    .description(
      'Save explicit text only; no source code or environment collection',
    )
    .requiredOption('--name <name>', 'checkpoint label')
    .option('--objective <text>', 'task objective', '')
    .option('--summary <text>', 'current progress', '')
    .option('--decision <text...>', 'decisions', [])
    .option('--next <text...>', 'next steps', [])
    .action(
      async (options: {
        name: string;
        objective: string;
        summary: string;
        decision: string[];
        next: string[];
      }) =>
        print(
          await saveCheckpoint(await root(), {
            name: options.name,
            objective: options.objective,
            summary: options.summary,
            decisions: options.decision,
            nextSteps: options.next,
          }),
        ),
    );
  context
    .command('restore <id>')
    .description('Preview checkpoint; --apply writes local context only')
    .option('--apply', 'apply the displayed checkpoint to local context')
    .action(async (id: string, options: { apply?: boolean }) =>
      print(await restoreCheckpoint(await root(), id, options.apply === true)),
    );
  const provider = program
    .command('provider')
    .description('Inspect optional providers without implicit connections');
  provider
    .command('list')
    .description(
      'List configured provider readiness and implemented capabilities (offline)',
    )
    .action(async () =>
      print({
        providers: await providerReports(await loadConfig(await root())),
      }),
    );
  provider
    .command('check <id>')
    .description(
      'Check readiness; --connect makes one approved non-inference connection check',
    )
    .option('--connect', 'contact the configured model-list endpoint')
    .option('--approve-network', 'approve this network connection')
    .option('--timeout-ms <milliseconds>', 'connection timeout', '10000')
    .action(
      async (
        id: string,
        options: {
          connect?: boolean;
          approveNetwork?: boolean;
          timeoutMs: string;
        },
      ) => {
        const config = await loadConfig(await root());
        const adapter = selectProvider(config, id);
        if (!options.connect) {
          if (options.approveNetwork)
            throw new AgentForgeError('--approve-network requires --connect.');
          const health = await adapter.health();
          print({ id: adapter.id, ...health });
          if (health.status === 'unavailable') process.exitCode = 3;
          return;
        }
        if (!config.permissions.allowNetwork || !options.approveNetwork)
          throw new AgentForgeError(
            'Network blocked. Enable permissions.allowNetwork and pass --approve-network.',
            6,
          );
        if (!adapter.checkConnection)
          throw new AgentForgeError(
            'Connection checks are unavailable for this provider.',
            3,
          );
        const health = await adapter.checkConnection({
          approved: true,
          timeoutMs: Number(options.timeoutMs),
          signal,
        });
        print({ id: adapter.id, ...health });
        if (health.status === 'unavailable') process.exitCode = 3;
      },
    );
  program
    .command('prompt')
    .description(
      'Structure/compact locally, or explicitly submit text to a configured provider',
    )
    .requiredOption('--task <text>', 'explicit task text')
    .option('--compact', 'remove consecutive exact duplicate prose lines')
    .option(
      '--model',
      'request inference from an explicitly selected configured model provider',
    )
    .option(
      '--provider <id>',
      'configured provider id: openai, anthropic, or ollama',
    )
    .option(
      '--approve-network',
      'approve sending this task text to the selected endpoint',
    )
    .option('--timeout-ms <milliseconds>', 'model request timeout', '60000')
    .option(
      '--stream',
      'emit sanitized provisional text lines and a terminal result as JSON Lines',
    )
    .option(
      '--schema <file>',
      'project-relative JSON Schema file for locally validated output',
    )
    .action(
      async (options: {
        task: string;
        compact?: boolean;
        model?: boolean;
        provider?: string;
        approveNetwork?: boolean;
        timeoutMs: string;
        stream?: boolean;
        schema?: string;
      }) => {
        if (!options.task.trim())
          throw new AgentForgeError('Task must not be empty.');
        if (options.task.length > 100000)
          throw new AgentForgeError('Prompt exceeds 100000 characters.');
        if (options.model) {
          if (options.compact)
            throw new AgentForgeError(
              '--compact and --model are separate operations.',
            );
          if (!options.provider)
            throw new AgentForgeError(
              'Model provider unavailable: select an explicitly configured provider with --provider.',
              3,
            );
          const directory = await root();
          const config = await loadConfig(directory);
          const adapter = selectProvider(config, options.provider);
          if (!config.permissions.allowNetwork || !options.approveNetwork)
            throw new AgentForgeError(
              'Network blocked. Review the task and endpoint, enable permissions.allowNetwork, and pass --approve-network.',
              6,
            );
          if (!adapter.submitPrompt)
            throw new AgentForgeError(
              'Prompt submission is unavailable for this provider.',
              3,
            );
          let responseSchema: Record<string, unknown> | undefined;
          if (options.schema) {
            const data = await readJson(directory, options.schema);
            if (data === undefined)
              throw new AgentForgeError('Schema file not found.');
            responseSchema = prepareSchema(data);
          }
          const request = {
            prompt: options.task,
            approved: true,
            timeoutMs: Number(options.timeoutMs),
            signal,
            ...(responseSchema === undefined ? {} : { responseSchema }),
          };
          if (options.stream) {
            if (!adapter.streamPrompt)
              throw new AgentForgeError(
                'Streaming is unavailable for this adapter.',
                3,
              );
            for await (const event of adapter.streamPrompt(request)) {
              // Adapter finalizers redact and validate; preserve validated data without a second mutation.
              console.log(JSON.stringify({ provider: adapter.id, ...event }));
              if (
                event.type === 'complete' &&
                event.result.finishReason !== 'completed'
              )
                process.exitCode = 4;
            }
          } else {
            const result = await adapter.submitPrompt(request);
            console.log(
              JSON.stringify({ provider: adapter.id, ...result }, null, 2),
            );
            if (result.finishReason !== 'completed') process.exitCode = 4;
          }
          return;
        }
        if (
          options.provider ||
          options.approveNetwork ||
          options.stream ||
          options.schema
        )
          throw new AgentForgeError(
            '--provider, --approve-network, --stream and --schema require --model.',
          );
        print(
          options.compact
            ? compactPrompt(options.task)
            : refinePrompt(options.task),
        );
      },
    );
  program
    .command('graph')
    .description(
      'Scan ignored-safe repository structure and static local JS/TS imports',
    )
    .action(async () => print(await scanRepository(await root())));
  for (const name of ['verify', 'run']) {
    program
      .command(name)
      .description(
        name === 'verify'
          ? 'Preview or execute configured verification checks'
          : 'Preview or execute bounded verification iterations (no automatic code edits)',
      )
      .option('--execute', 'execute declared processes')
      .option(
        '--approve',
        'approve the displayed configured processes for this invocation',
      )
      .action(async (options: { execute?: boolean; approve?: boolean }) => {
        const directory = await root();
        const config = await loadConfig(directory);
        if (!options.execute) {
          print({
            executed: false,
            checks: config.verification.checks,
            limits: { ...config.verification, ...config.workflow },
            required:
              'Review commands, set permissions.allowProcess=true, then use --execute --approve.',
          });
          return;
        }
        if (!options.approve || !config.permissions.allowProcess)
          throw new AgentForgeError(
            'Execution blocked. Review commands, enable permissions.allowProcess, and pass --execute --approve.',
            6,
          );
        if (!config.verification.checks.length)
          throw new AgentForgeError(
            'No verification checks configured. Set verification.checks first.',
          );
        const engineOptions = {
          approved: true,
          timeoutMs: config.verification.timeoutMs,
          maxOutputBytes: config.verification.maxOutputBytes,
          signal,
        };
        if (name === 'verify') {
          const results = await runChecks(
            directory,
            config.verification.checks,
            engineOptions,
          );
          print({ executed: true, results });
          if (results.some((result) => result.status === 'cancelled'))
            process.exitCode = 5;
          else if (results.some((result) => result.status === 'unavailable'))
            process.exitCode = 3;
          else if (results.some((result) => result.status !== 'passed'))
            process.exitCode = 4;
        } else {
          const result = await runWorkflow(
            directory,
            config.verification.checks,
            { ...engineOptions, ...config.workflow },
          );
          print({ executed: true, ...result });
          if (result.status === 'cancelled') process.exitCode = 5;
          else if (
            result.iterations.some((iteration) =>
              iteration.some((check) => check.status === 'unavailable'),
            )
          )
            process.exitCode = 3;
          else if (result.status !== 'passed') process.exitCode = 4;
        }
      });
  }
  return program;
}
