# Support

Start with `agentforge --help`, `agentforge doctor`, the [command reference](docs/cli/commands.md) and [troubleshooting](docs/cli/troubleshooting.md). Development invocation is `npm run dev -- <command>`; the built invocation is `node dist/cli/index.js <command>`.

No public repository, discussion forum, support email or service-level commitment is configured. For help from the person who supplied your checkout, use an existing verified way to reach them. Do not assume any address or project with a similar name is associated with this toolkit.

For a reproducible non-sensitive bug report, capture the command, exit code, Node/OS versions, sanitized configuration and expected versus observed behavior. Include the smallest failing fixture and checks actually run. Inspect output for private values before sharing it.

Security-sensitive reports need a verified private route; see [SECURITY.md](SECURITY.md). GitHub issue templates are prepared for a future repository, but their presence does not mean a hosted support channel exists.

For permission failures, inspect `agentforge config`, `agentforge tools list` and `agentforge orchestrate status`; permission plus an invocation flag is required, and tool execution additionally needs exact terminal approval. For model setup use `agentforge provider list` or `agentforge provider check <id>` offline. `--connect --approve-network` makes a real endpoint request only after network policy allows it; do not use it just to collect an offline bug report.

A hard-link, symbolic-link, malformed UTF-8 or changed-during-read failure is a safety refusal. Use ordinary trusted regular files and retry after external writes stop. An unsafe `.gitignore` blocks reads rather than silently skipping policy. `agentforge edit capabilities` explains why application is unavailable; use the complete preview for manual review without disabling the check. Do not include raw source, full prompts, tool arguments or environment values in reports.

Developer reproductions can use `npm run check`, `npm run test:packed` and, on macOS/Linux with Python 3, `npm run test:terminal`. Review local-only reports before sharing them; see the [release checklist](docs/development/release-process.md) for remaining public-distribution prerequisites.
