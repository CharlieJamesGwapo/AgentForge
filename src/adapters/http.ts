import { z } from 'zod';
import { redact } from '../shared/safety.js';
import { ProviderError } from './errors.js';
import type {
  ProviderOptions,
  PromptInput,
  RequestOptions,
  PromptResult,
} from './types.js';

export const credentialEnvSchema = z
  .string()
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN)$/);
const modelWithoutControlCharacters = new RegExp(
  String.raw`^[^\u0000-\u001f\u007f-\u009f]*$`,
  'u',
);
/** Reject terminal and protocol controls before whitespace normalization. */
export const providerModelSchema = z
  .string()
  .regex(modelWithoutControlCharacters)
  .trim()
  .min(1)
  .max(200);
const providerOptionsSchema = z.strictObject({
  model: providerModelSchema,
  baseUrl: z.string().max(2048).optional(),
  apiKeyEnv: credentialEnvSchema.optional(),
  maxOutputTokens: z.number().int().min(1).max(32768).optional(),
});
export function validateBaseUrl(value: string): string {
  try {
    if (
      typeof value !== 'string' ||
      value.trim() !== value ||
      value.length > 2048 ||
      /[\r\n\0]/.test(value)
    )
      throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash)
      throw new Error();
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new ProviderError(
      'configuration',
      'Provider URL must use HTTPS (or loopback HTTP) and contain no credentials, query, or fragment.',
    );
  }
}
export function validateProviderOptions(
  options: ProviderOptions,
  defaultBaseUrl: string,
  defaultApiKeyEnv?: string,
): Required<Pick<ProviderOptions, 'model' | 'baseUrl' | 'maxOutputTokens'>> & {
  apiKeyEnv?: string;
} {
  const parsed = providerOptionsSchema.safeParse(options);
  if (!parsed.success)
    throw new ProviderError(
      'configuration',
      'Invalid provider options. Specify a model, safe endpoint, credential environment name and bounded output limit; inline credentials are forbidden.',
    );
  return {
    ...parsed.data,
    baseUrl: validateBaseUrl(parsed.data.baseUrl ?? defaultBaseUrl),
    maxOutputTokens: parsed.data.maxOutputTokens ?? 1024,
    apiKeyEnv: parsed.data.apiKeyEnv ?? defaultApiKeyEnv,
  };
}
export function getCredential(envName: string): string | undefined {
  if (!credentialEnvSchema.safeParse(envName).success)
    throw new ProviderError(
      'configuration',
      'Credential environment references must end in _KEY or _TOKEN.',
    );
  const value = process.env[envName];
  if (value === undefined || !value.trim()) return undefined;
  if (value.length > 16384 || /[^\x21-\x7e]/.test(value))
    throw new ProviderError(
      'configuration',
      'Credential environment value contains unsupported characters.',
    );
  return value;
}
export function validatePrompt(input: PromptInput): void {
  if (
    !input ||
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    input.prompt.length > 100000
  )
    throw new ProviderError(
      'configuration',
      'Prompt must contain 1–100000 characters.',
    );
}
export interface JsonRequest extends RequestOptions {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  maxResponseBytes?: number;
}
/** A single bounded request. No implicit authorization, redirects, retries or body diagnostics. */
export async function* requestBytes(
  input: JsonRequest,
): AsyncGenerator<Uint8Array> {
  if (input.approved !== true)
    throw new ProviderError(
      'policy',
      'Network request blocked. Explicit approval is required.',
    );
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 300000
  )
    throw new ProviderError(
      'configuration',
      'Provider timeout must be 1–300000 ms.',
    );
  const maximum = input.maxResponseBytes ?? 1048576;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1048576)
    throw new ProviderError(
      'configuration',
      'Provider response limit must be 1–1048576 bytes.',
    );
  const url = validateBaseUrl(input.url);
  if (input.method !== 'GET' && input.method !== 'POST')
    throw new ProviderError(
      'configuration',
      'Unsupported provider HTTP method.',
    );
  if (input.signal?.aborted)
    throw new ProviderError('cancelled', 'Provider request cancelled.');
  let body: string | undefined;
  try {
    body = input.body === undefined ? undefined : JSON.stringify(input.body);
  } catch {
    throw new ProviderError(
      'configuration',
      'Provider request must contain JSON-serializable data.',
    );
  }
  if (body !== undefined && Buffer.byteLength(body) > 1048576)
    throw new ProviderError('configuration', 'Provider request exceeds 1 MiB.');
  const controller = new AbortController();
  let aborted: 'timeout' | 'cancelled' | undefined;
  const stop = (reason: 'timeout' | 'cancelled') => {
    if (!aborted) {
      aborted = reason;
      controller.abort();
    }
  };
  const timeout = setTimeout(() => stop('timeout'), input.timeoutMs);
  const onAbort = () => stop('cancelled');
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      method: input.method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...input.headers,
      },
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      credentials: 'omit',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      throw new ProviderError(
        'policy',
        'Provider redirect blocked. Configure the final trusted endpoint explicitly.',
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const code =
        response.status === 401 || response.status === 403
          ? 'authentication'
          : response.status === 429
            ? 'rate-limit'
            : 'unavailable';
      throw new ProviderError(
        code,
        `Provider HTTP request failed (${response.status}). Response body omitted.`,
        response.status,
      );
    }
    const size = response.headers.get('content-length');
    if (size !== null && Number(size) > maximum) {
      void response.body?.cancel().catch(() => {});
      throw new ProviderError(
        'response-limit',
        'Provider response exceeds the configured byte limit.',
      );
    }
    if (!response.body)
      throw new ProviderError(
        'invalid-response',
        'Provider returned no JSON response body.',
      );
    reader = response.body.getReader();
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        void reader.cancel().catch(() => {});
        throw new ProviderError(
          'response-limit',
          'Provider response exceeds the configured byte limit.',
        );
      }
      yield value;
    }
    if (aborted)
      throw new ProviderError(
        aborted,
        aborted === 'timeout'
          ? 'Provider request timed out.'
          : 'Provider request cancelled.',
      );
  } catch (error) {
    if (aborted)
      throw new ProviderError(
        aborted,
        aborted === 'timeout'
          ? 'Provider request timed out.'
          : 'Provider request cancelled.',
      );
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      'unavailable',
      'Provider connection failed. Check the trusted endpoint and network.',
    );
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onAbort);
    controller.abort();
    void reader?.cancel().catch(() => {});
    try {
      reader?.releaseLock();
    } catch {
      /* Pending reads are stopped by abort. */
    }
    controller.abort();
  }
}

export async function requestJson(input: JsonRequest): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of requestBytes(input)) chunks.push(chunk);
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch {
    throw new ProviderError(
      'invalid-response',
      'Provider returned invalid JSON. Response content omitted.',
    );
  }
}

/** Remove even short explicitly selected credentials from untrusted provider text/metadata. */
export function redactPromptResult(
  result: PromptResult,
  credential?: string,
): PromptResult {
  const secrets = credential ? [credential] : [];
  return {
    ...result,
    text: redact(result.text, secrets),
    model: redact(result.model, secrets),
  };
}
