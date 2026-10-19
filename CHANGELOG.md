# Changelog

## Unreleased

Added approved local Git status, bounded existing-file diff, limited history and local branch inspection, including explicit missing-Git/nonrepo/unborn states. Execution uses fixed arguments, root/metadata/config policy, disabled filters and bounded cancellation/output handling. Added ordinary/streaming adapter continuation tests and temporary-repository CLI tests.

Added approved unique replacement and strict single-file patch previews, complete bounded diffs, byte hashes, per-registry expiring proposals and a disabled-by-default write permission. Application needs a second exact approval and checks stale identity/content. Per the explicit user choice, the Node backend fails closed before any write when atomic conflict-safe replacement is unavailable. Added local capability reporting and provider/CLI approval regressions.

Added optional provider-neutral planner/executor conversations with explicit role/model configuration, disabled-by-default scheduling, at most two workers and finite depth/context/output/deadline budgets. Plans and worker claims are validated locally; results include conflicts/failures/partial completion. Workers inherit snapshotted scoped tools and centrally serialized exact approval, without arbitrary subprocess or delegation tools. Added mixed-provider role fixtures and CLI/permission/cancellation/budget regressions. External coding-host integrations remain unavailable.

Initial local development implementation: CLI, strict configuration, safe JSON storage, context checkpoints, 13 portable skills, prompt tools, static graph discovery, bounded verification workflows, adapter contracts, tests and documentation.

The package version `0.1.0-dev.0` identifies this checkout for local builds. It is not a published release. No release dates, tags or download links are claimed.

Added optional OpenAI Responses, Anthropic Messages and Ollama text adapters; offline provider readiness, explicit approved connection/inference commands, native usage, completion states and bounded HTTP errors. Existing configurations load with network access disabled. Added local HTTP protocol and CLI integration tests; no provider SDK, paid request or publication.

Added native SSE/NDJSON streaming and shared structured-output validation for all three model adapters; CLI JSON Lines and project-relative schema input; strict portable schema limits, cancellation, terminal-state checks and regression coverage for cross-line credential prefixes, schema snapshots and SSE framing.

Added provider-neutral client function conversations across all three optional adapters, native continuation/reasoning replay, strict argument/result correlation and bounded rounds. Added a separate immutable-batch executor requiring one-use explicit approval, fixed project-summary/configured-check tools, additive disabled-by-default tool permission, and CLI per-batch terminal approval. Local protocol, denial, cancellation, mutation and process-effect tests cover the boundary.

Added streaming client tool sessions for OpenAI Responses SSE, Anthropic Messages SSE and Ollama Chat NDJSON. Partial arguments stay private; clean native termination, complete argument validation and iterator exhaustion precede exact batch approval. Added `tools run --stream`, shared streamed/ordinary continuation state, cancellation/early-return handling, native delta consistency checks and loopback regression coverage.

Added combined client tools and structured final output across all optional providers in ordinary/streaming modes. Sessions snapshot final schemas, send them alongside tools on every request, distinguish pending/valid/unavailable output, validate raw and redacted final data, and withhold all schema-mode text deltas. Added `tools run --schema`, safe project-relative loading, approval/effect regression tests, native combined-field fixtures and mutation/redaction coverage. No new permission or runtime dependency was added.

Added optional local `ToolDefinition.resultSchema` validation across all optional providers in ordinary and streaming tool sessions. Successful results validate as raw JSON and redacted data before continuation; executor validation failures stop later handlers, and session validation failures block follow-up without retrying consumed approval. Result contracts are snapshotted into approval reviews and omitted from native declarations. Built-in tools now provide result schemas; `tools run --result-schemas` loads safe project-relative overrides separately from final-answer `--schema`. Added execution, CLI and three-provider contract tests. No dependency, permission or remote was added.

Added approved provider-neutral `project_search` and `project_read` with safe bounded listing/search/ranges, ignore and credential exclusions, strict UTF-8, link/special-file protections and strict argument/result validation. Added a composed `task` runtime using existing prompt/context/session code, optional model/context, exact approval, cumulative usage, total limits and safe failure output. Fixed ordinary invalid UTF-8 acceptance and sensitive structured property-name leaks; unvalidated structured commentary/length/refusal text is withheld. Added filesystem/runtime/cross-provider tests and an isolated packed-install smoke command used by prepared CI. Existing `run` behavior and all 13 skills are preserved.

### Security and release preparation

Hardened JSON, skill, graph and ignore-policy reads against outside-inode hard links, short reads and concurrent changes; rejected malformed UTF-8 where previously replacement-decoded. Failed storage writes/syncs clean temporary files and preserve existing data. Redacted unterminated private-key output.

Rejected terminal controls in configured and overridden model IDs. Sanitized explicit provider credentials in runtime, orchestration, status/config and connection diagnostics, including custom short values; withheld credential-bearing tool property names and typed JSON primitives without coercing schema types.

Added cross-provider multi-turn checkpoint/structured runtime regressions and a repeatable installed pseudo-terminal suite covering approval, denial, cancellation and stale edit conflicts. Expanded offline help examples, documented release/security boundaries, and prepared Linux/macOS checks with a limited Windows installation job. This remains an unpublished private development package; no release or remote operation was performed.

Prevented FIFO-open hangs in JSON, skill and graph readers with nonblocking descriptor opens before regular-file checks. Added a real POSIX named-pipe regression and model-control parity coverage against the generated config schema.
