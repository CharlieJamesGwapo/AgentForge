import { AgentForgeError } from '../shared/errors.js';
export type ProviderErrorCode =
  | 'configuration'
  | 'authentication'
  | 'rate-limit'
  | 'unavailable'
  | 'invalid-response'
  | 'timeout'
  | 'cancelled'
  | 'policy'
  | 'response-limit'
  | 'validation';
const exits: Record<ProviderErrorCode, number> = {
  configuration: 2,
  authentication: 3,
  'rate-limit': 3,
  unavailable: 3,
  'invalid-response': 1,
  timeout: 1,
  cancelled: 5,
  policy: 6,
  'response-limit': 1,
  validation: 4,
};
export class ProviderError extends AgentForgeError {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message, exits[code]);
    this.name = 'ProviderError';
  }
}
