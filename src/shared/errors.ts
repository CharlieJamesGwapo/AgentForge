export class AgentForgeError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 2,
  ) {
    super(message);
    this.name = 'AgentForgeError';
  }
}
