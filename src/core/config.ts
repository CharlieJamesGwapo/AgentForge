import path from 'node:path';
import { z } from 'zod';
import { readJson, writeJson } from './storage.js';
import { AgentForgeError } from '../shared/errors.js';
import {
  credentialEnvSchema,
  providerModelSchema,
  validateBaseUrl,
} from '../adapters/http.js';

// Control characters must be rejected in persisted paths.
const relativePath = z
  .string()
  .min(1)
  .max(200)
  .regex(
    new RegExp(
      String.raw`^(?!\/)(?!.*[:\\\x00-\x1f])(?!.*\/\/)(?!.*\/$)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[\s\S]+$`,
      'u',
    ),
    'Expected a safe relative path',
  );
export const checkSchema = z.strictObject({
  name: z.string().min(1).max(80),
  command: z
    .string()
    .min(1)
    .max(1000)
    .refine((s) => !s.includes('\0')),
  args: z
    .array(
      z
        .string()
        .max(10000)
        .refine((s) => !s.includes('\0')),
    )
    .max(100),
});
export const providerConfigSchema = z.strictObject({
  id: z.enum(['openai', 'anthropic', 'ollama']),
  model: providerModelSchema,
  baseUrl: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        validateBaseUrl(value);
        return true;
      } catch {
        return false;
      }
    }, 'Use HTTPS or loopback HTTP, without credentials, query or fragment')
    .optional(),
  apiKeyEnv: credentialEnvSchema.optional(),
  maxOutputTokens: z.number().int().min(1).max(32768).optional(),
});
const orchestrationRoleSchema = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  model: providerConfigSchema.shape.model.optional(),
});
const orchestrationDefaults = {
  enabled: false,
  maxConcurrency: 2,
  maxDepth: 1,
  maxSubtasks: 8,
  maxContextBytes: 16384,
  maxOutputBytes: 32768,
  timeoutMs: 60000,
  maxDurationMs: 300000,
  planner: null,
  executor: null,
};
export const orchestrationSchema = z.strictObject({
  enabled: z.boolean(),
  maxConcurrency: z.number().int().min(1).max(2),
  maxDepth: z.number().int().min(0).max(1),
  maxSubtasks: z.number().int().min(1).max(8),
  maxContextBytes: z.number().int().min(256).max(32768),
  maxOutputBytes: z.number().int().min(256).max(65536),
  timeoutMs: z.number().int().min(1).max(300000),
  maxDurationMs: z.number().int().min(1).max(600000),
  planner: orchestrationRoleSchema.nullable(),
  executor: orchestrationRoleSchema.nullable(),
});
export const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  project: z.string().min(1).max(120),
  enabledSkills: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).max(200),
  skillDirectories: z.array(relativePath).max(20),
  checkpointDirectory: relativePath.regex(
    /^\.agentforge\//,
    'Checkpoints must be inside .agentforge/',
  ),
  verification: z.strictObject({
    checks: z.array(checkSchema).max(50),
    timeoutMs: z.number().int().min(1).max(300000),
    maxOutputBytes: z.number().int().min(1).max(1048576),
  }),
  workflow: z.strictObject({
    maxIterations: z.number().int().min(1).max(10),
    maxDurationMs: z.number().int().min(1).max(600000),
  }),
  adapters: z
    .array(z.enum(['local']))
    .min(1)
    .max(1),
  providers: z
    .array(providerConfigSchema)
    .max(3)
    .refine(
      (values) =>
        new Set(values.map((value) => value.id)).size === values.length,
      'Provider identifiers must be unique',
    )
    .default([]),
  orchestration: orchestrationSchema.default(orchestrationDefaults),
  permissions: z.strictObject({
    allowProcess: z.boolean(),
    allowNetwork: z.boolean().default(false),
    allowTools: z.boolean().default(false),
    allowWrite: z.boolean().default(false),
  }),
});
export type Config = z.infer<typeof configSchema>;
export const defaultConfig: Config = {
  schemaVersion: 1,
  project: 'project',
  enabledSkills: [
    'promptforge',
    'tokensaver',
    'contextpilot',
    'promptloop',
    'graphify',
    'uiux-architect',
    'smartdiff',
    'verifyloop',
    'debugsherlock',
    'agentflow',
    'secureship',
    'skillforge',
    'shipnotes',
  ],
  skillDirectories: ['.agentforge/skills'],
  checkpointDirectory: '.agentforge/checkpoints',
  verification: { checks: [], timeoutMs: 30000, maxOutputBytes: 65536 },
  workflow: { maxIterations: 3, maxDurationMs: 120000 },
  adapters: ['local'],
  providers: [],
  orchestration: { ...orchestrationDefaults },
  permissions: {
    allowProcess: false,
    allowNetwork: false,
    allowTools: false,
    allowWrite: false,
  },
};
export const CONFIG_FILE = 'agentforge.config.json';
export function validateConfig(data: unknown): Config {
  const result = configSchema.safeParse(data);
  if (!result.success)
    throw new AgentForgeError(
      `Invalid configuration fields: ${result.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}. See docs/getting-started/configuration.md.`,
    );
  return result.data;
}
export async function loadConfig(root: string): Promise<Config> {
  const data = await readJson(root, CONFIG_FILE);
  if (data === undefined)
    throw new AgentForgeError(
      'No agentforge.config.json. Run agentforge init first.',
    );
  return validateConfig(data);
}
export async function initProject(
  root: string,
): Promise<{ created: boolean; config: Config }> {
  const existing = await readJson(root, CONFIG_FILE);
  if (existing !== undefined)
    return { created: false, config: validateConfig(existing) };
  const config = validateConfig({
    ...defaultConfig,
    project: path.basename(path.resolve(root)),
  });
  try {
    await writeJson(root, CONFIG_FILE, config, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return { created: false, config: await loadConfig(root) };
    throw error;
  }
  return { created: true, config };
}
export function getConfig(config: Config, key: string): unknown {
  if (
    !/^[a-zA-Z]+(?:\.[a-zA-Z]+)*$/.test(key) ||
    key
      .split('.')
      .some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))
  )
    throw new AgentForgeError('Invalid configuration key.');
  let value: unknown = config;
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part))
      throw new AgentForgeError('Unknown configuration key.');
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export async function setConfig(
  root: string,
  key: string,
  value: unknown,
): Promise<Config> {
  const config = await loadConfig(root);
  getConfig(config, key);
  const parts = key.split('.');
  let target = config as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1))
    target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = value;
  const next = validateConfig(config);
  await writeJson(root, CONFIG_FILE, next);
  return next;
}
