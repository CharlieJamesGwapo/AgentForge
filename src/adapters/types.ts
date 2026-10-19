/** Adapters describe implemented capabilities; selection never grants permissions. */
export interface AdapterCapabilities {
  promptSubmission: boolean;
  structuredResponses: boolean;
  streaming?: boolean;
  toolInvocation: boolean;
  toolStreaming?: boolean;
  usageTelemetry: boolean;
  cancellation: boolean;
}
export interface AdapterHealth {
  status: 'available' | 'unavailable';
  authentication: 'not-required' | 'configured' | 'missing';
  connection?: 'not-checked' | 'verified';
  detail: string;
}
export interface ProviderOptions {
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxOutputTokens?: number;
}
export interface RequestOptions {
  timeoutMs: number;
  approved: boolean;
  signal?: AbortSignal;
}
export interface PromptInput extends RequestOptions {
  prompt: string;
  responseSchema?: Record<string, unknown>;
}
export interface PromptResult {
  text: string;
  model: string;
  finishReason: 'completed' | 'length' | 'refusal';
  structured?:
    | { status: 'valid'; data: unknown }
    | { status: 'unavailable'; reason: 'length' | 'refusal' };
  usage:
    | {
        status: 'available';
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
        cacheCreationInputTokens?: number;
      }
    | { status: 'unavailable' };
}
export type PromptStreamEvent =
  | { type: 'text-delta'; text: string; provisional: true }
  | { type: 'complete'; result: PromptResult };
/** Client-owned functions only. Descriptions and schemas grant no execution rights. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Local result contract. Never sent as a provider tool field. */
  resultSchema?: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ToolResult {
  callId: string;
  output: string;
  isError?: boolean;
}
export interface ToolSessionInput {
  prompt: string;
  tools: ToolDefinition[];
  maxTurns?: number;
  responseSchema?: Record<string, unknown>;
}
/** Internal wire options: the session supplies its validated schema snapshot each turn. */
export interface ToolRequestOptions extends RequestOptions {
  responseSchema?: Record<string, unknown>;
}
export interface ToolTurn extends Omit<
  PromptResult,
  'finishReason' | 'structured'
> {
  finishReason: PromptResult['finishReason'] | 'tool-calls';
  calls: ToolCall[];
  structured?:
    PromptResult['structured'] | { status: 'pending'; reason: 'tool-calls' };
}
export interface ToolSession {
  /** Sends one network request, never executes a tool. Results must match the pending batch. */
  next(input: RequestOptions & { results?: ToolResult[] }): Promise<ToolTurn>;
  /** Partial arguments are private. Only a validated terminal event can expose calls. */
  stream?(
    input: RequestOptions & { results?: ToolResult[] },
  ): AsyncIterable<ToolStreamEvent>;
}
export type ToolStreamEvent =
  | { type: 'text-delta'; text: string; provisional: true }
  | { type: 'complete'; turn: ToolTurn };
export interface ProviderAdapter {
  readonly id: string;
  readonly version: string;
  readonly kind: 'local' | 'model-provider' | 'coding-host' | 'agent-runtime';
  capabilities(): AdapterCapabilities;
  /** Offline credential/configuration readiness only. Never sends requests. */
  health(): Promise<AdapterHealth>;
  /** Explicitly authorized connection check; no inference or model installation. */
  checkConnection?(input: RequestOptions): Promise<AdapterHealth>;
  submitPrompt?(input: PromptInput): Promise<PromptResult>;
  streamPrompt?(input: PromptInput): AsyncIterable<PromptStreamEvent>;
  createToolSession?(input: ToolSessionInput): ToolSession;
}
