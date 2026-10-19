# Testing

`npm test` runs TypeScript tests with Node's test runner through tsx. Tests use temporary directories and short real child processes; no credentials or paid APIs are needed. Core storage tests cover initialization, strict edits, malformed config, path safety, redaction and checkpoint restore. CLI tests invoke the real executable entry point. Engine tests cover skill parsing, prompt preservation, graph ignores/imports and bounded process workflows.

`npm run check` runs all required project checks. `npm audit` contacts the registry separately. `npm pack --dry-run` inspects bundled files; an isolated prefix installation exercises the compiled binary and bundled skills. Workflows are prepared for GitHub, but their presence is not evidence that hosted CI has run.

Add a failing reproduction before a bug fix. Tests that only mirror implementation structure are insufficient; assert outcomes, errors and preserved data.

Tool-result coverage includes all three loopback native protocols in ordinary and streaming modes, successful canonical JSON, correlation/order, local-only result contracts, raw/type/redaction failures before follow-up, selected short credentials, normalized errors, immutable approval/schema snapshots, one-use approvals, stopped later effects, built-in output contracts and safe CLI override loading. Packaged CLI pseudo-terminal smoke checks exercise approval, denial, cancellation and intentional schema failure with real harmless configured subprocesses. These local fixtures do not establish live account/model or Windows compatibility.

`npm run test:packed` builds, creates an unpublished archive, installs it into an isolated temporary prefix using the npm cache, and invokes its real compiled CLI. It verifies credential-free basic commands, task help/policy, all three providers in both modes using loopback fixtures, schema success and noninteractive file-tool previews. The prepared CI workflow runs it after `npm run check`. Interactive approved/denied/cancelled runs are separately exercised with pseudo-terminals during local verification. No live inference is used.

## Repeatable installed terminal workflows

`npm run test:terminal` runs the committed `tests/terminal-install.smoke.ts` with `tests/helpers/terminal-pty.py`. It needs Python 3, Git and POSIX pseudo-terminals (macOS/Linux). It packs and installs the actual production CLI into a fresh temporary prefix, exercises approved/denied/cancelled Git and edit operations, verifies stale-file conflict and unavailable application, and runs planner/worker and ordinary/streaming checkpoint-plus-structured tasks against all three loopback protocols. The harness asserts HTTP continuation counts, exit codes, approval prompts and absence of denied source disclosure. Temporary data is cleaned afterward.

`tests/runtime-audit.test.ts` composes actual checkpoint storage, refined prompts, provider/model overrides, repeated project reads with fresh approvals, structured finals and usage. Denial at either read, provider failure after a completed read and credential-bearing preflight failure are covered. `tests/privacy-hardening.test.ts` covers terminal model controls, custom short credentials, sensitive tool property names and typed secret payloads. Storage/skill/graph/file tests use actual file handles and narrow fault injection to exercise short reads, mutation, hard links, invalid UTF-8 and sync-failure recovery.

Prepared CI covers full checks on Linux Node 22/24 and macOS Node 24. A narrower Windows Node 24 job type-checks and runs the packed-install suite; it does not run POSIX terminal tests or establish complete Windows filesystem/process behavior. Hosted workflows have not run from this local checkout. Preserve real result counts in local audit reports rather than treating workflow configuration as a successful run.

## Fresh-runner installation and deadline regression

The packed and terminal suites derive an isolated installer lock from the committed dependency lock plus the locally packed archive and its integrity hash, then use `npm ci --offline --ignore-scripts --omit=dev`. Cached dependency tarballs are still required; cached registry metadata is not. A real regression creates local fixture archives with an empty metadata cache, confirms the legacy offline install fails, then verifies locked installation succeeds without registry requests.

The pending-approval deadline test waits for approval to begin before firing only the task deadline timer. Other timers remain native and the test includes deliberate response latency. This checks timeout, preserved partial output and refusal of late approval independently of CI runner speed; runtime limits and permission checks are unchanged.
