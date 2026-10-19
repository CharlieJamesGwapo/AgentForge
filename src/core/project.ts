import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { listCheckpoints } from './context.js';
import { safePath } from '../shared/safety.js';
import { AgentForgeError } from '../shared/errors.js';
import { localAdapter } from '../adapters/local.js';
import { providerReports } from '../adapters/registry.js';
import { discoverSkills } from '../engines/skills.js';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export async function projectRoot(input: string): Promise<string> {
  try {
    const root = await realpath(path.resolve(input));
    if (!(await stat(root)).isDirectory()) throw new Error();
    return root;
  } catch {
    throw new AgentForgeError('Project directory must exist and be readable.');
  }
}
export async function skillRoots(
  root: string,
  config?: Config,
): Promise<string[]> {
  const roots = [path.join(packageRoot, 'skills')];
  if (config)
    for (const directory of config.skillDirectories)
      roots.push(await safePath(root, directory));
  return [...new Set(roots)];
}
export async function projectStatus(root: string) {
  const config = await loadConfig(root);
  const skills = await discoverSkills(await skillRoots(root, config));
  const checkpoints = await listCheckpoints(root);
  return {
    project: config.project,
    config,
    skills: skills.map((skill) => ({
      id: skill.id,
      enabled: config.enabledSkills.includes(skill.id),
    })),
    checkpoints: checkpoints.map(({ id, name, createdAt }) => ({
      id,
      name,
      createdAt,
    })),
    adapters: [
      {
        id: localAdapter.id,
        capabilities: localAdapter.capabilities(),
        ...(await localAdapter.health()),
      },
      ...(await providerReports(config)),
    ],
  };
}
export async function doctor(root: string) {
  const checks: { name: string; status: string; detail: string }[] = [];
  checks.push({
    name: 'node',
    status:
      Number(process.versions.node.split('.')[0]) >= 24 ||
      (Number(process.versions.node.split('.')[0]) === 22 &&
        Number(process.versions.node.split('.')[1]) >= 13)
        ? 'passed'
        : 'failed',
    detail: process.versions.node,
  });
  try {
    await access(root, constants.R_OK | constants.W_OK);
    checks.push({
      name: 'project-permissions',
      status: 'passed',
      detail: 'Project root is readable and writable.',
    });
  } catch {
    checks.push({
      name: 'project-permissions',
      status: 'failed',
      detail: 'Project root needs read and write access.',
    });
  }
  try {
    const config = await loadConfig(root);
    for (const check of config.verification.checks) {
      const candidates = check.command.includes(path.sep)
        ? [path.resolve(root, check.command)]
        : (process.env.PATH ?? '')
            .split(path.delimiter)
            .map((directory) => path.resolve(directory || root, check.command));
      let available = false;
      for (const candidate of candidates) {
        try {
          await access(candidate, constants.X_OK);
          if ((await stat(candidate)).isFile()) {
            available = true;
            break;
          }
        } catch {
          /* Try the next PATH location without executing anything. */
        }
      }
      checks.push({
        name: `executable:${check.name}`,
        status: available ? 'passed' : 'failed',
        detail: available
          ? 'Configured executable is accessible.'
          : 'Configured executable is unavailable; review command/PATH.',
      });
    }
    checks.push({
      name: 'configuration',
      status: 'passed',
      detail: 'Schema version 1 is valid.',
    });
  } catch (error) {
    checks.push({
      name: 'configuration',
      status: 'failed',
      detail: (error as Error).message,
    });
  }
  try {
    const { stdout } = await promisify(execFile)('git', ['--version'], {
      timeout: 3000,
      maxBuffer: 4096,
    });
    checks.push({ name: 'git', status: 'passed', detail: stdout.trim() });
  } catch {
    checks.push({
      name: 'git',
      status: 'unavailable',
      detail: 'Git is optional for the local engines.',
    });
  }
  let providers: Awaited<ReturnType<typeof providerReports>> = [];
  try {
    providers = await providerReports(await loadConfig(root));
    if (providers.length === 0)
      checks.push({
        name: 'model-provider',
        status: 'unavailable',
        detail:
          'No model provider is configured. Core local commands do not require one.',
      });
    for (const provider of providers)
      checks.push({
        name: `model-provider:${provider.id}`,
        status: provider.status === 'available' ? 'ready' : 'unavailable',
        detail: provider.detail,
      });
  } catch (error) {
    checks.push({
      name: 'model-providers',
      status: 'failed',
      detail: (error as Error).message,
    });
  }
  return {
    healthy: !checks.some((check) => check.status === 'failed'),
    checks,
    adapter: { id: 'local', ...(await localAdapter.health()) },
    providers,
  };
}
