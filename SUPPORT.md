# Support

Start with `agentforge --help`, `agentforge doctor`, the [command reference](docs/cli/commands.md) and [troubleshooting](docs/cli/troubleshooting.md). Development invocation is `npm run dev -- <command>`; the built invocation is `node dist/cli/index.js <command>`.

Use [GitHub Issues](https://github.com/CharlieJamesGwapo/AgentForge/issues) for non-sensitive bugs, feature requests and questions about the public source. The repository includes bug, feature and skill proposal templates. No dedicated support email, discussion forum or response-time commitment is established. Do not assume an address or similarly named project is associated with this toolkit.

For a reproducible non-sensitive bug report, capture the command, exit code, Node/OS versions, sanitized configuration and expected versus observed behavior. Include the smallest failing fixture and checks actually run. Inspect output for private values before sharing it.

Security-sensitive reports need a verified private route; see [SECURITY.md](SECURITY.md). Do not post credentials, private source or undisclosed exploit details to public issues.

For permission failures, inspect `agentforge config`, `agentforge tools list` and `agentforge orchestrate status`; permission plus an invocation flag is required, and tool execution additionally needs exact terminal approval. For model setup use `agentforge provider list` or `agentforge provider check <id>` offline. `--connect --approve-network` makes a real endpoint request only after network policy allows it; do not use it just to collect an offline bug report.

A hard-link, symbolic-link, malformed UTF-8 or changed-during-read failure is a safety refusal. Use ordinary trusted regular files and retry after external writes stop. An unsafe `.gitignore` blocks reads rather than silently skipping policy. `agentforge edit capabilities` explains why application is unavailable; use the complete preview for manual review without disabling the check. Do not include raw source, full prompts, tool arguments or environment values in reports.

Developer reproductions can use `npm run check`, `npm run test:packed` and, on macOS/Linux with Python 3, `npm run test:terminal`. Review local-only reports before sharing them; see the [release checklist](docs/development/release-process.md) for requirements before a versioned release.
