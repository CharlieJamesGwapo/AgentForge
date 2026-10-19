# Testing

`npm test` runs TypeScript tests with Node's test runner through tsx. Tests use temporary directories and short real child processes; no credentials or paid APIs are needed. Core storage tests cover initialization, strict edits, malformed config, path safety, redaction and checkpoint restore. CLI tests invoke the real executable entry point. Engine tests cover skill parsing, prompt preservation, graph ignores/imports and bounded process workflows.

`npm run check` runs all required project checks. `npm audit` contacts the registry separately. `npm pack --dry-run` inspects bundled files; an isolated prefix installation exercises the compiled binary and bundled skills. Hosted results are recorded below for a specific commit; workflow configuration alone does not prove later changes pass.

Add a failing reproduction before a bug fix. Tests that only mirror implementation structure are insufficient; assert outcomes, errors and preserved data.

Tool-result coverage includes all three loopback native protocols in ordinary and streaming modes, successful canonical JSON, correlation/order, local-only result contracts, raw/type/redaction failures before follow-up, selected short credentials, normalized errors, immutable approval/schema snapshots, one-use approvals, stopped later effects, built-in output contracts and safe CLI override loading. Packaged CLI pseudo-terminal smoke checks exercise approval, denial, cancellation and intentional schema failure with real harmless configured subprocesses. These local fixtures do not establish live account/model compatibility or complete Windows filesystem/process behavior.

`npm run test:packed` builds, creates an unpublished archive, installs it into an isolated temporary prefix using the npm cache, and invokes its real compiled CLI. It verifies credential-free basic commands, task help/policy, all three providers in both modes using loopback fixtures, schema success and noninteractive file-tool previews. Linux/macOS CI runs it after `npm run check`; the Windows job runs it after type checking. Interactive approved/denied/cancelled runs are separately exercised with pseudo-terminals locally and in Linux/macOS CI. No live inference is used.

## Repeatable installed terminal workflows

`npm run test:terminal` runs the committed `tests/terminal-install.smoke.ts` with `tests/helpers/terminal-pty.py`. It needs Python 3, Git and POSIX pseudo-terminals (macOS/Linux). It packs and installs the actual production CLI into a fresh temporary prefix, exercises approved/denied/cancelled Git and edit operations, verifies stale-file conflict and unavailable application, and runs planner/worker and ordinary/streaming checkpoint-plus-structured tasks against all three loopback protocols. The harness asserts HTTP continuation counts, exit codes, approval prompts and absence of denied source disclosure. Temporary data is cleaned afterward.

`tests/runtime-audit.test.ts` composes actual checkpoint storage, refined prompts, provider/model overrides, repeated project reads with fresh approvals, structured finals and usage. Denial at either read, provider failure after a completed read and credential-bearing preflight failure are covered. `tests/privacy-hardening.test.ts` covers terminal model controls, custom short credentials, sensitive tool property names and typed secret payloads. Storage/skill/graph/file tests use actual file handles and narrow fault injection to exercise short reads, mutation, hard links, invalid UTF-8 and sync-failure recovery.

## Verified hosted CI

On **2026-10-19**, GitHub reported success for all seven checks across four push workflows at commit [`86cce82`](https://github.com/CharlieJamesGwapo/AgentForge/commit/86cce82c2c45a4a09a8a5c767f571326d1df2f9c).

| Run                                                                                                   | Passing scope                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [CI](https://github.com/CharlieJamesGwapo/AgentForge/actions/runs/39191455765)                        | Linux Node 22/24 and macOS Node 24: `npm run check`, `test:packed`, `test:terminal`; Windows Node 24: `typecheck`, `test:packed` |
| [Documentation validation](https://github.com/CharlieJamesGwapo/AgentForge/actions/runs/39191455882)  | Local documentation links                                                                                                        |
| [Skill validation](https://github.com/CharlieJamesGwapo/AgentForge/actions/runs/39191455796)          | All 13 bundled skills                                                                                                            |
| [Dependency advisory check](https://github.com/CharlieJamesGwapo/AgentForge/actions/runs/39191455845) | `npm audit --audit-level=high`                                                                                                   |

The full check includes formatting, lint, strict types, 499 unit/integration tests, build, skill/schema validation and documentation links at that commit. Windows does not run the full test suite or POSIX terminal tests; installation success does not establish complete Windows filesystem/process behavior. No workflow uses live AI providers. These results do not cover later uncommitted changes; consult [current Actions runs](https://github.com/CharlieJamesGwapo/AgentForge/actions) for newer commits.

## Fresh-runner installation and deadline regression

The packed and terminal suites derive an isolated installer lock from the committed dependency lock plus the locally packed archive and its integrity hash, then use `npm ci --offline --ignore-scripts --omit=dev`. Cached dependency tarballs are still required; cached registry metadata is not. A real regression creates local fixture archives with an empty metadata cache, confirms the legacy offline install fails, then verifies locked installation succeeds without registry requests.

The pending-approval deadline test waits for approval to begin before firing only the task deadline timer. Other timers remain native and the test includes deliberate response latency. This checks timeout, preserved partial output and refusal of late approval independently of CI runner speed; runtime limits and permission checks are unchanged.

The packed smoke harness removes credential-like inherited environment variables before launching child CLI processes, then injects only synthetic loopback fixture credentials. This keeps host/runner credentials from changing fixture assertions; it does not test live authentication.
