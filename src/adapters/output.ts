import { Ajv2020 } from 'ajv/dist/2020.js';
import { ProviderError } from './errors.js';
import {
  hasSensitivePropertyNames,
  hasSensitiveSerializedPrimitiveValues,
  redact,
  redactValue,
} from '../shared/safety.js';
import { redactPromptResult } from './http.js';
import type { PromptInput, PromptResult, PromptStreamEvent } from './types.js';
const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  ownProperties: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  allowUnionTypes: true,
  validateFormats: false,
});
function invalidSchema(): never {
  throw new ProviderError(
    'configuration',
    'Unsupported output schema. Use bounded object/array/scalar types, scalar enums, required properties and additionalProperties:false; references and other keywords are unsupported.',
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** A portable, deliberately bounded JSON Schema subset. No network refs or regex compilation. */
export function prepareSchema(
  value: unknown,
  root: 'object' | 'any' = 'object',
): Record<string, unknown> {
  let schema: unknown;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded) > 65536)
      invalidSchema();
    schema = JSON.parse(encoded) as unknown;
  } catch {
    invalidSchema();
  }
  let nodes = 0;
  function check(node: unknown, depth: number): void {
    nodes++;
    if (nodes > 256 || depth > 12 || !record(node)) invalidSchema();
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (
      types.length < 1 ||
      types.length > 2 ||
      types.some(
        (type) =>
          ![
            'object',
            'array',
            'string',
            'integer',
            'number',
            'boolean',
            'null',
          ].includes(String(type)),
      ) ||
      new Set(types).size !== types.length
    )
      invalidSchema();
    if (types.length === 2 && !types.includes('null')) invalidSchema();
    const primary = types.find((type) => type !== 'null') ?? 'null';
    const allowed = new Set([
      'type',
      'description',
      'enum',
      ...(primary === 'object'
        ? ['properties', 'required', 'additionalProperties']
        : primary === 'array'
          ? ['items']
          : []),
    ]);
    if (Object.keys(node).some((key) => !allowed.has(key))) invalidSchema();
    if (
      node.description !== undefined &&
      (typeof node.description !== 'string' || node.description.length > 2048)
    )
      invalidSchema();
    if (node.enum !== undefined) {
      if (
        !Array.isArray(node.enum) ||
        node.enum.length < 1 ||
        node.enum.length > 128 ||
        node.enum.some(
          (item) =>
            item !== null &&
            !['string', 'number', 'boolean'].includes(typeof item),
        )
      )
        invalidSchema();
    }
    if (primary === 'object') {
      if (
        !record(node.properties) ||
        node.additionalProperties !== false ||
        !Array.isArray(node.required)
      )
        invalidSchema();
      const names = Object.keys(node.properties);
      if (
        names.length > 64 ||
        names.some(
          (key) =>
            key.length > 128 ||
            ['__proto__', 'constructor', 'prototype'].includes(key),
        ) ||
        node.required.length !== names.length ||
        new Set(node.required).size !== names.length ||
        node.required.some(
          (key) =>
            typeof key !== 'string' ||
            !Object.hasOwn(node.properties as object, key),
        )
      )
        invalidSchema();
      for (const child of Object.values(node.properties))
        check(child, depth + 1);
    } else if (primary === 'array') {
      check(node.items, depth + 1);
    }
  }
  check(schema, 0);
  if (!record(schema) || (root === 'object' && schema.type !== 'object'))
    invalidSchema();
  try {
    ajv.compile(schema);
    ajv.removeSchema(schema);
  } catch {
    invalidSchema();
  }
  return schema;
}
export function validateSchemaData(
  data: unknown,
  schema: Record<string, unknown>,
): boolean {
  let count = 0;
  const stack: [unknown, number][] = [[data, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (++count > 50000 || depth > 64) return false;
    if (item && typeof item === 'object')
      for (const value of Object.values(item)) stack.push([value, depth + 1]);
  }
  const validate = ajv.compile(schema);
  try {
    return validate(data) === true;
  } finally {
    ajv.removeSchema(schema);
  }
}
export function finishPrompt(
  result: PromptResult,
  input: PromptInput,
  credential?: string,
): PromptResult {
  if (input.responseSchema === undefined)
    return redactPromptResult(result, credential);
  const schema = prepareSchema(input.responseSchema);
  if (result.finishReason !== 'completed')
    return {
      ...redactPromptResult(result, credential),
      text: '',
      structured: { status: 'unavailable', reason: result.finishReason },
    };
  let data: unknown;
  try {
    data = JSON.parse(result.text) as unknown;
  } catch {
    throw new ProviderError(
      'validation',
      'Structured output is not valid JSON. Output omitted.',
    );
  }
  if (!validateSchemaData(data, schema))
    throw new ProviderError(
      'validation',
      'Structured output does not match the schema. Output omitted.',
    );
  if (hasSensitivePropertyNames(data, credential ? [credential] : []))
    throw new ProviderError(
      'validation',
      'Structured output contains sensitive property names. Output omitted.',
    );
  const safe = redactValue(data, credential ? [credential] : []);
  if (
    hasSensitiveSerializedPrimitiveValues(safe, credential ? [credential] : [])
  )
    throw new ProviderError(
      'validation',
      'Structured output contains a sensitive typed value. Output omitted.',
    );
  if (!validateSchemaData(safe, schema))
    throw new ProviderError(
      'validation',
      'Redacted structured output does not match the schema. Output omitted.',
    );
  return {
    ...redactPromptResult(result, credential),
    text: JSON.stringify(safe),
    structured: { status: 'valid', data: safe },
  };
}
/** Emit sanitized complete lines; structured data is withheld until a validated terminal result. */
export async function* finalizeStream(
  source: AsyncIterable<PromptStreamEvent>,
  input: PromptInput,
  credential?: string,
): AsyncGenerator<PromptStreamEvent> {
  const snapshot = {
    ...input,
    ...(input.responseSchema === undefined
      ? {}
      : { responseSchema: prepareSchema(input.responseSchema) }),
  };
  let raw = '',
    pending = '',
    terminal = false;
  for await (const event of source) {
    if (terminal)
      throw new ProviderError(
        'invalid-response',
        'Provider stream continued after completion.',
      );
    if (event.type === 'text-delta') {
      raw += event.text;
      pending += event.text;
      if (Buffer.byteLength(raw) > 1048576)
        throw new ProviderError(
          'response-limit',
          'Provider text exceeds the output limit.',
        );
      if (snapshot.responseSchema !== undefined) continue;
      let end = pending.lastIndexOf('\n') + 1;
      // A credential introducer can span lines (for example Bearer\n<value>).
      // Retain incomplete prefixes, including a preceding prefix before a keyword-like value.
      for (let attempt = 0; attempt < 2 && end > 0; attempt++) {
        const prefix =
          /\b(?:Bearer|api[_-]?key|access[_-]?token|token|secret|password|authorization)\s*["']?\s*(?:[:=]\s*)?$/i.exec(
            pending.slice(0, end),
          );
        if (!prefix) break;
        end = attempt === 1 ? 0 : prefix.index;
      }

      const begin = pending.indexOf('-----BEGIN ');
      if (begin >= 0 && !pending.slice(begin).includes('PRIVATE KEY-----'))
        end = Math.min(end, begin);
      if (
        begin >= 0 &&
        pending.slice(begin).includes('PRIVATE KEY-----') &&
        !/-----END [A-Z ]*PRIVATE KEY-----/.test(pending.slice(begin))
      )
        end = Math.min(end, begin);
      if (end > 0) {
        const text = redact(
          pending.slice(0, end),
          credential ? [credential] : [],
        );
        pending = pending.slice(end);
        yield { type: 'text-delta', text, provisional: true };
      }
    } else {
      terminal = true;
      if (!event.result.text.startsWith(raw))
        throw new ProviderError(
          'invalid-response',
          'Provider terminal text disagrees with stream deltas.',
        );
      pending += event.result.text.slice(raw.length);
      const result = finishPrompt(event.result, snapshot, credential);
      if (snapshot.responseSchema === undefined && pending)
        yield {
          type: 'text-delta',
          text: redact(pending, credential ? [credential] : []),
          provisional: true,
        };
      yield { type: 'complete', result };
    }
  }
  if (!terminal)
    throw new ProviderError(
      'invalid-response',
      'Provider stream ended without a completion event.',
    );
}
