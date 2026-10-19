import type { ProviderAdapter } from './types.js';
export const localAdapter: ProviderAdapter = {
  id: 'local',
  version: '1.0.0',
  kind: 'local',
  capabilities: () => ({
    promptSubmission: false,
    structuredResponses: false,
    streaming: false,
    toolInvocation: false,
    usageTelemetry: false,
    cancellation: false,
  }),
  health: async () => ({
    status: 'available',
    authentication: 'not-required',
    detail:
      'Local deterministic engines are available. This adapter does not provide model inference, remote tools or usage telemetry; optional model providers are selected separately.',
  }),
};
