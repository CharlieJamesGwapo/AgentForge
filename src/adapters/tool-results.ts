import { ProviderError } from './errors.js';
import { prepareSchema, validateSchemaData } from './output.js';
import {
  hasSensitivePropertyNames,
  hasSensitiveSerializedPrimitiveValues,
  redact,
  redactValue,
} from '../shared/safety.js';
import type { ToolResult } from './types.js';
export const TOOL_ERROR_OUTPUT =
  'Tool failed or result exceeded limits. Details omitted.';
/** Result schemas allow any JSON root; argument and final-answer roots stay objects. */
export function prepareResultSchema(value: unknown): Record<string, unknown> {
  return prepareSchema(value, 'any');
}
function invalid(): never {
  throw new ProviderError(
    'validation',
    'Tool result is invalid or does not match its result schema. Output omitted.',
  );
}
/** Validate raw JSON, redact as data, and revalidate before returning canonical JSON. */
export function validateToolResult(
  result: ToolResult,
  resultSchema?: Record<string, unknown>,
  sensitiveValues: readonly string[] = [],
): ToolResult {
  if (typeof result.output !== 'string') invalid();
  if (Buffer.byteLength(result.output) > 65536)
    throw new ProviderError(
      'validation',
      'Tool result exceeds byte limit. Output omitted.',
    );
  if (resultSchema === undefined) {
    const output = redact(result.output, sensitiveValues);
    if (Buffer.byteLength(output) > 65536)
      throw new ProviderError(
        'validation',
        'Redacted tool result exceeds byte limit. Output omitted.',
      );
    return { ...result, output };
  }
  const schema = prepareResultSchema(resultSchema);
  if (result.isError === true)
    return {
      callId: result.callId,
      output: redact(TOOL_ERROR_OUTPUT, sensitiveValues),
      isError: true,
    };
  let data: unknown;
  try {
    data = JSON.parse(result.output) as unknown;
  } catch {
    invalid();
  }
  if (!validateSchemaData(data, schema)) invalid();
  if (hasSensitivePropertyNames(data, sensitiveValues)) invalid();
  const safe = redactValue(data, sensitiveValues);
  if (hasSensitiveSerializedPrimitiveValues(safe, sensitiveValues)) invalid();
  if (!validateSchemaData(safe, schema)) invalid();
  const output = JSON.stringify(safe);
  if (Buffer.byteLength(output) > 65536)
    throw new ProviderError(
      'validation',
      'Redacted tool result exceeds byte limit. Output omitted.',
    );
  return {
    callId: result.callId,
    output,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}
