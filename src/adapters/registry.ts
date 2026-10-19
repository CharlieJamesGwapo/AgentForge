import type { Config } from '../core/config.js';
import type { ProviderAdapter } from './types.js';
import { getCredential } from './http.js';
import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { OllamaAdapter } from './ollama.js';
import { ProviderError } from './errors.js';

const DEFAULT_CREDENTIAL_ENV: Partial<
  Record<Config['providers'][number]['id'], string>
> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** Resolve credential values only for provider identities selected by the caller. */
export function configuredProviderCredentials(
  config: Config,
  providerIds: readonly string[],
): string[] {
  const selected = new Set(providerIds);
  const values = new Set<string>();
  for (const provider of config.providers) {
    if (!selected.has(provider.id)) continue;
    const envName = provider.apiKeyEnv ?? DEFAULT_CREDENTIAL_ENV[provider.id];
    if (!envName) continue;
    try {
      const value = getCredential(envName);
      if (value) values.add(value);
    } catch {
      // Invalid credentials are rejected by the selected adapter when it runs.
    }
  }
  return [...values];
}

export function configuredProviders(config: Config): ProviderAdapter[] {
  return config.providers.map(({ id, ...options }) => {
    switch (id) {
      case 'openai':
        return new OpenAIAdapter(options);
      case 'anthropic':
        return new AnthropicAdapter(options);
      case 'ollama':
        return new OllamaAdapter(options);
    }
  });
}
export function selectProvider(config: Config, id: string): ProviderAdapter {
  const adapter = configuredProviders(config).find(
    (provider) => provider.id === id,
  );
  if (!adapter)
    throw new ProviderError(
      'unavailable',
      'Requested model provider is not configured. Set providers with an explicit provider id and model.',
    );
  return adapter;
}
export async function providerReports(config: Config) {
  return Promise.all(
    configuredProviders(config).map(async (adapter) => ({
      id: adapter.id,
      kind: adapter.kind,
      version: adapter.version,
      capabilities: adapter.capabilities(),
      ...(await adapter.health()),
    })),
  );
}
