import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AgentForgeError } from './errors.js';

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export async function safePath(
  root: string,
  relative: string,
): Promise<string> {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative
      .split('/')
      .some(
        (part) => !part || part === '.' || part === '..' || part.includes(':'),
      )
  ) {
    throw new AgentForgeError(
      'Path must be a non-empty relative path without traversal.',
      6,
    );
  }
  const base = await realpath(root);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new AgentForgeError(
          'Symbolic links are not allowed for project data paths.',
          6,
        );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return current;
}

export function redact(
  text: string,
  sensitiveValues: readonly string[] = [],
): string {
  let result = text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|secret|password|authorization)\s*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,})\b/g,
      '[REDACTED]',
    );
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /(?:token|secret|password|api[_-]?key|credential)/i.test(key) &&
      value &&
      value.length >= 4
    )
      result = result.split(value).join('[REDACTED]');
  }
  for (const value of [...sensitiveValues]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    result = result.split(value).join('[REDACTED]');
  return result;
}

export function redactValue(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): unknown {
  if (typeof value === 'string') return redact(value, sensitiveValues);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, sensitiveValues));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:api[_-]?key|token|secret|password|authorization)$/i.test(key)
          ? '[REDACTED]'
          : redactValue(item, sensitiveValues),
      ]),
    );
  return value;
}

/** JSON object property names cannot be silently renamed without changing their contract. */
export function hasSensitivePropertyNames(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): boolean {
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item)) stack.push(...item);
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (redact(key, sensitiveValues) !== key) return true;
        stack.push(child);
      }
    }
  }
  return false;
}

/** Detect credentials left in typed, non-string JSON leaves after normal text redaction. */
export function hasSensitiveSerializedPrimitiveValues(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): boolean {
  const secrets = sensitiveValues.filter(Boolean);
  if (secrets.length === 0) return false;
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item)) stack.push(...item);
    else if (item && typeof item === 'object')
      stack.push(...Object.values(item));
    else if (typeof item !== 'string' && item !== undefined) {
      const serialized = JSON.stringify(item);
      if (
        serialized !== undefined &&
        secrets.some((secret) => serialized.includes(secret))
      )
        return true;
    }
  }
  return false;
}
