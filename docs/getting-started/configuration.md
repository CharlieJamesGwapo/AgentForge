# Configuration

`agentforge init` writes `agentforge.config.json` with schema version 1. The [JSON schema](../../schemas/config.schema.json) is generated from the runtime validator. Unknown keys are errors; there is no implicit migration, provider switching or environment merge.

| Setting                                               | Meaning and bounds                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| project                                               | Non-empty local project name, at most 120 characters                                                                                |
| enabledSkills                                         | Skill ids reported as enabled; this does not run them                                                                               |
| skillDirectories                                      | Up to 20 safe project-relative discovery roots                                                                                      |
| checkpointDirectory                                   | Safe relative directory inside `.agentforge/`                                                                                       |
| verification.checks                                   | Up to 50 objects with name, executable command, and string args array                                                               |
| verification.timeoutMs                                | Per-process timeout, 1–300000 ms                                                                                                    |
| verification.maxOutputBytes                           | Combined captured output limit, 1–1048576 bytes                                                                                     |
| workflow.maxIterations                                | 1–10 check iterations                                                                                                               |
| workflow.maxDurationMs                                | Total workflow deadline, 1–600000 ms                                                                                                |
| adapters                                              | Only the shipped `local` adapter is registered                                                                                      |
| providers                                             | Optional array of unique openai/anthropic/ollama entries with explicit model and optional endpoint, credential env and output bound |
| permissions.allowNetwork                              | False by default; each provider request additionally needs --approve-network                                                        |
| permissions.allowProcess                              | False by default; enabling still requires invocation approval                                                                       |
| permissions.allowTools                                | False by default; execution also requires --execute and exact interactive approval for each tool batch                              |
| permissions.allowWrite                                | False by default; exposes apply requests only with fresh exact approval; current backend always fails closed before writing         |
| orchestration.enabled                                 | False by default; cannot be enabled by an invocation flag                                                                           |
| orchestration.planner / executor                      | Null by default; explicit configured provider reference and optional model override                                                 |
| orchestration.maxConcurrency / maxDepth / maxSubtasks | Defaults 2 / 1 / 8; bounds 1–2 / 0–1 / 1–8                                                                                          |
| orchestration.maxContextBytes / maxOutputBytes        | Defaults 16384 / 32768; bounds 256–32768 / 256–65536                                                                                |
| orchestration.timeoutMs / maxDurationMs               | Defaults 60000 / 300000; bounds 1–300000 / 1–600000 ms                                                                              |

Use `config get workflow.maxIterations` or `config set workflow.maxIterations 2`. Objects, arrays, numbers and booleans are JSON; other values are plain strings. Updates validate the whole document before atomic replacement. Concurrent edits have last-writer-wins behavior; avoid editing the config in two processes at once.

Keep credentials out of this file. It may be tracked because it contains only shareable policy/settings; `.agentforge/`, environment files and local outputs are ignored. Never store tokens in command arguments. Settings paths cannot contain traversal, symlinks or absolute locations. Invalid files must be repaired explicitly; `init` will not replace a malformed file.

Optional provider settings are described in [provider setup](../integrations/providers.md). Existing schema-v1 files load with an empty provider array and network disabled. Runtime URL checks additionally enforce HTTPS/loopback, credential-free URLs and no query/fragment. Secrets remain in environment variables, never inline configuration. The `adapters` field still describes the local runtime; model entries are independently configured in `providers`.

Existing schema-v1 files also load with writes and orchestration disabled, without automatic rewrites. All orchestration roles/permissions are snapshotted before planning. See [role configuration and budget semantics](../features/orchestration.md); `orchestrate status` and `config` remain offline.
