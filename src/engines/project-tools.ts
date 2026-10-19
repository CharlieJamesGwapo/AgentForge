import type { Config } from '../core/config.js';
import { readJson } from '../core/storage.js';
import { cloneToolJson } from '../adapters/tools.js';
import { runChecks } from './verification.js';
import { projectFileTools } from './project-file-tools.js';
import { gitTools } from './git-tools.js';
import { projectEditTools } from './project-edit-tools.js';
import type { RegisteredTool } from './tools.js';
/** A fixed host-owned registry. Only file tools accept bounded project-relative paths. */
export function projectTools(root: string, config: Config): RegisteredTool[] {
  const snapshot = cloneToolJson(config, 1048576);
  const tools: RegisteredTool[] = [
    {
      definition: {
        name: 'project_summary',
        description:
          'Read the configured project name and package.json name, version and script names. Does not read source files.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        resultSchema: {
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
        },
      },
      review: () => ({
        read: 'package.json',
        fields: ['name', 'version', 'script names'],
        shareWithProvider: true,
      }),
      execute: async (_args, signal) => {
        if (signal.aborted) throw new Error('Cancelled');
        const value = await readJson(root, 'package.json');
        const pkg =
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        return {
          project: snapshot.project,
          package: {
            name: typeof pkg.name === 'string' ? pkg.name : null,
            version: typeof pkg.version === 'string' ? pkg.version : null,
            scripts:
              pkg.scripts &&
              typeof pkg.scripts === 'object' &&
              !Array.isArray(pkg.scripts)
                ? Object.keys(pkg.scripts)
                : [],
          },
        };
      },
    },
  ];
  tools.push(...projectFileTools(root));
  tools.push(
    ...projectEditTools(root, { allowWrite: snapshot.permissions.allowWrite }),
  );
  if (snapshot.permissions.allowProcess) tools.push(...gitTools(root));
  const checks = snapshot.verification.checks;
  if (
    snapshot.permissions.allowProcess &&
    checks.length &&
    new Set(checks.map((check) => check.name)).size === checks.length
  )
    tools.push({
      definition: {
        name: 'verification_check',
        description:
          'Run one preconfigured verification check by name. Commands and arguments are fixed by the project configuration.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: checks.map((check) => check.name) },
          },
          required: ['name'],
          additionalProperties: false,
        },
        resultSchema: {
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
        },
      },
      review: (args) => ({
        check: cloneToolJson(
          checks.find((check) => check.name === args.name) ?? null,
        ),
        shareWithProvider: true,
      }),
      execute: async (args, signal) =>
        runChecks(root, [checks.find((check) => check.name === args.name)!], {
          approved: true,
          signal,
          timeoutMs: snapshot.verification.timeoutMs,
          maxOutputBytes: snapshot.verification.maxOutputBytes,
        }),
    });
  return tools;
}
