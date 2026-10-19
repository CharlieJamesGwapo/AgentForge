# Client tool invocation

OpenAI Responses, Anthropic Messages and Ollama Chat can request registered client functions through the same provider-neutral contract. Adapters return calls; the independent execution engine runs trusted host handlers only after explicit approval. No provider is required for local commands.

## CLI

Configure an explicit provider/model as described in [provider setup](providers.md). Tool declarations can be inspected offline:

```sh
agentforge tools list
agentforge config set permissions.allowNetwork true
agentforge tools run --provider ollama --task "Summarize this project" --approve-network
```

The last command makes an approved model request and prints a pending batch if the model requests tools. It executes nothing. Exit 6 means approval is required. A model that answers directly needs no tool approval.

For an interactive conversation:

```sh
agentforge config set permissions.allowTools true
agentforge tools run --provider ollama --task "Summarize this project" --approve-network --execute
```

Every batch displays the tool call IDs, exact names/arguments, resolved effects, any local result schemas and a random-bound SHA-256 approval ID. Type `approve <the displayed approval ID>` at the terminal to execute that batch and send its sanitized results back to this provider. Press Enter to decline. Each subsequent batch needs a new approval; the ID cannot be reused. Network permission, tool permission or `--execute` alone cannot approve a tool call. A pipe or redirected input cannot provide approval, and `--approve` is not accepted. Noninteractive runs return pending calls for inspection; these previews cannot be resumed in a later process.

Output is JSON Lines (`tool-turn`, `approval-required`, `tool-results`, `tool-conversation`) on stdout. Interactive prompts use stderr. Ctrl+C cancels requests, approval prompts and cooperative execution. `--max-turns` is 1–10 (default 6, including the first and final network turns). A call on the last permitted turn is rejected before execution because no follow-up is available. `--timeout-ms` is 1–300000 (default 60000) per network request. Execution uses the configured verification deadline. Completed text exits 0; a partial/refused final answer exits 4.

## Fixed CLI registry

| Tool                                                 | Effect                                                                                         | Additional permission                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `project_summary`                                    | Read only project name and package.json name, version and script names                         | Batch approval                                     |
| `project_search`                                     | Search allowed project paths or UTF-8 content; empty path query lists files                    | Batch approval                                     |
| `project_read`                                       | Read a bounded line range from an allowed project UTF-8 file                                   | Batch approval                                     |
| `git_status` / `git_diff` / `git_log` / `git_branch` | Inspect bounded local Git state, existing-file diffs, history and branches                     | Process permission and batch approval              |
| `project_edit_replace` / `project_edit_patch`        | Fully read one existing file and compute a complete bounded diff                               | Batch approval                                     |
| `project_edit_apply`                                 | Recheck a session-bound proposal; current backend returns conflict/unavailable without writing | Write permission and a fresh exact batch approval  |
| `verification_check`                                 | Run one configured check selected by name; command/argv come from a snapshot of configuration  | `permissions.allowProcess=true` and batch approval |

`verification_check` is offered only when process permission is enabled and configured check names are unique. Its argument schema enumerates those names. The approval view resolves the actual command and arguments before execution. Verification arguments cannot supply a path, executable, shell command, imported module or handler. Only the bounded file tools accept validated project-relative paths. No source or checkpoint is attached automatically. Approving a tool explicitly authorizes sharing its returned data with the selected provider during this conversation.

See [Git inspection](git-inspection.md) and [edit previews](project-edits.md) for operation-specific path, repository, size and platform policy. Built-in [orchestration](../features/orchestration.md) narrows this registry by assigned scopes and excludes configured verification processes and file application. It retains exact approval for every worker batch.

## Programmatic contract

`ProviderAdapter.createToolSession({prompt, tools, maxTurns?, responseSchema?})` snapshots tool declarations without making a request. `session.next({approved, timeoutMs, signal?, results?})` makes one approved request and never executes a function. It returns a `ToolTurn` with text, model, finish reason, usage and normalized calls `{id, name, arguments}`. A tool turn uses `finishReason: 'tool-calls'`.

Calls must reference a registered tool, use a JSON object matching its schema without coercion, and have unique IDs within the batch. `next` then requires exactly one result `{callId, output, isError?}` for every pending call. Results are reordered to call order before native encoding. OpenAI replays native output and encrypted reasoning with `store:false`; Anthropic replays assistant content and returns tool results together in a user message; Ollama preserves thinking and correlates tool messages by name and order, assigning IDs where the protocol omits them. Native continuation state stays in memory and is absent from public reports.

Use `prepareToolBatch(registry, calls)` from `src/engines/tools.ts` to bind immutable calls and resolved review details to host-owned functions. `batch.execute({approved:true, approvalId:batch.approvalId, signal?, timeoutMs?})` requires explicit exact approval and consumes it once. The application must obtain that approval from its user; do not auto-approve based on model text. `runToolConversation` provides the bounded request/approval/execution/result loop using a required host approval callback. A host can also use sessions without the loop and manage results itself.

## Validation and limits

- 1–16 declared tools, at most 16 calls per response; schemas use the [portable strict subset](streaming-structured.md).
- Declarations/batches/results are bounded to 256 KiB; individual results to 64 KiB; native history and HTTP bodies to 1 MiB; JSON depth/node limits also apply.
- Missing, duplicate, unknown, uncorrelated, malformed or schema-invalid calls are rejected before execution. Invalid results prevent the follow-up request; executor schema-bound result failures also stop later handlers in that batch. Length-limited or refused responses cannot expose executable calls.
- Calls that would change under secret redaction are rejected. Arguments are never silently rewritten before execution. Resolved reviews containing recognizable secrets are also rejected. Tool text/results are sanitized before reporting or follow-up requests.
- All calls validate before any handler starts; batches run sequentially. Handler exceptions produce generic error results without exception details. An invalid/oversized schema-bound result fails validation and stops the batch; legacy untyped serialization/size errors produce generic error results. Cancellation/deadline stops the batch and prevents subsequent handlers.
- Approval cannot roll back a handler that already ran. Trusted JavaScript handlers must honor their abort signal; this engine cannot preempt synchronous JavaScript or sandbox plugins. The fixed process tool inherits the existing verification process controls and OS limitations in [security boundaries](../architecture/security-boundaries.md).

Both ordinary and streaming client functions are supported. Combined final response schemas are supported in both modes. Provider-hosted tools, MCP dispatch and arbitrary CLI plugins are unsupported. Existing text streaming and structured prompt output retain their separate APIs. Tests use local protocol fixtures; live account/model support is unverified.

Protocol references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling).

CLI `tool-results` events contain call IDs and return/error status, without repeating result payloads. Selected credentials are also redacted by the session before results are encoded into a follow-up request. Native reasoning/thinking blocks must have valid replay shapes before calls can reach the approval boundary.

## Streaming tools

```sh
agentforge tools run --provider ollama --task "Run a configured check" --approve-network --stream
# To enable per-batch interactive approval, add --execute after enabling permissions.allowTools.
```

All three optional adapters advertise `toolStreaming: true`. `--stream` applies to every network turn, including follow-up requests after approved tool results. Provisional, sanitized `text-delta` events can appear while the provider works. Function names, raw argument fragments and native reasoning remain private until full call validation. A `tool-turn` and the approval prompt appear only after valid native termination and a clean end of the bounded response stream. A truncated stream, mismatched terminal, invalid argument schema, post-terminal error or cancellation cannot become an executable batch.

Programmatic callers use `session.stream({approved, timeoutMs, signal?, results?})`, receiving `ToolStreamEvent` values: `{type:'text-delta', text, provisional:true}` and exactly one validated `{type:'complete', turn}`. Streamed and ordinary turns share pending calls, result correlation and turn budgets. Request fields/results are snapshotted before lazy iteration. Calls remain subject to exact batch approval; consuming a complete event grants no execution permission. Early iterator return closes the native request and invalidates that in-flight session. `runToolConversation({stream:true, ...})` consumes the stream fully before requesting approval and accepts `onEvent` for provisional/terminal reports.

Wire decoding uses OpenAI and Anthropic SSE and Ollama NDJSON. Native argument chunks are reconstructed and checked against the final response before public calls are returned. Anthropic tool input JSON is parsed only after the block closes; signed thinking remains private for continuation. Indexed Ollama calls are correlated without using a function name as their identity. Unindexed complete calls retain their order, including repeated function names. Ambiguous or conflicting updates fail instead of guessing arguments.

Text uses the same line-aware sanitization as ordinary prompt streams. Incomplete lines or credential prefixes may be buffered until enough text arrives to sanitize them. Provisional text is not a validated final answer. Stream framing remains bounded to 1 MiB and 10000 events per request, with existing network deadlines/cancellation and no automatic retries or provider fallback.

## Combining tools and a structured final answer

```sh
agentforge tools run --provider ollama --task "Inspect the project, then return JSON" --approve-network --schema answer.schema.json
# --stream is also supported. Execution still needs --execute and exact per-batch approval.
```

The schema file is a bounded, safe project-relative JSON file using the existing portable strict subset. It is read and validated before any provider request. The session snapshots it once and sends a fresh copy with the tool declarations on every network turn, including after approved results. Native fields are OpenAI `text.format` with strict JSON Schema, Anthropic `output_config.format`, and Ollama `format`. Changing the caller's schema object or a codec's wire copy cannot weaken final validation. Schemas, including descriptions/enums, are explicit content sent to the selected endpoint.

The contracts remain separate: tool arguments must match their registered tool schema and need approval before execution. A final answer must match the response schema. A turn containing actual client calls has `structured: {status:'pending', reason:'tool-calls'}`; its commentary is not a validated final answer. A completed final with no calls has `structured: {status:'valid', data: ...}` after raw JSON validation, data redaction and revalidation. The returned `text` is the exact JSON serialization of that validated data. A final refusal or length limit has `structured: {status:'unavailable', reason:'refusal'|'length'}` and CLI exit 4.

With `--schema --stream`, all provisional text is withheld, including interim tool commentary, because the client cannot know a turn's role before native completion. Only complete validated tool turns/final answers are reported. Invalid JSON or schema mismatch exits 4 without the invalid payload; no repair, coercion, schema weakening, retry or provider fallback occurs. Already approved effects are not rolled back, and a failed final closes the session without rerunning them. Tool-looking JSON inside final data is ordinary data and is never executed.

For programmatic use, pass `responseSchema` to `createToolSession` and use `next` or `stream` as usual. Structured status is optional when no schema was requested; schema requests do not grant tool approval. A backend/model can reject the combination even when the wrapper supports its native fields; such errors remain explicit. Compatibility tests use local fixtures, not live account/model inference.

## Validating tool results

`ToolDefinition.resultSchema` is optional local policy. The engine and all three adapters enforce it for ordinary and streaming sessions, independently of argument `parameters` and final `responseSchema`. It is never sent as a provider tool field. Existing programmatic tools without it retain opaque-string results; both fixed CLI tools provide schemas by default:

- `project_summary` returns an object with `project` and `package` (`name`, `version`, script names).
- `verification_check` returns an array of check records with name, status, nullable exit code, stdout, stderr and duration.

Result schemas use the same [bounded strict subset](streaming-structured.md#portable-schema-subset), allowing any JSON root, including arrays, scalars and null. Object schemas still require every property and `additionalProperties:false`; no refs, patterns, coercion, repair or defaults are accepted. Argument and final schemas still require an object root.

For a programmatic tool, add for example `resultSchema: {type:'string'}` and return a JavaScript string from its handler. The executor converts the value into JSON. A host supplying results directly to `session.next` or `session.stream` must send JSON text in `output`, so a string result is `JSON.stringify('ready')`, not bare `ready`. IDs must still match pending calls exactly. The complete result batch validates before any native follow-up request. Session contracts are snapshotted; caller mutation cannot weaken them.

Successful results validate as raw data, then are redacted as data and revalidated. The accepted data is serialized as JSON without a subsequent string-redaction pass that could break JSON syntax. Sensitive property names are withheld rather than renamed. Redaction that breaks an enum/type contract fails validation. The session also redacts the explicitly selected credential, including short values. Error results (`isError:true`) are separate from the success schema: for typed tools their output is replaced with the fixed generic message `Tool failed or result exceeded limits. Details omitted.` (subject to credential redaction). Arbitrary error payloads never bypass validation into provider history.

CLI overrides are explicit local policy:

```sh
agentforge tools run --provider ollama --task "Inspect the project" --approve-network --result-schemas examples/tool-result-schemas.json
# Add --stream and/or --schema answer.schema.json as needed.
# Execution still requires --execute, tool permission and exact terminal approval.
```

The file maps 1–16 registered tool names to schemas. Unknown names, unsupported schemas, missing/malformed files, traversal and symlinks are rejected before requests. It is bounded to 256 KiB after JSON serialization and uses the existing safe 1 MiB file reader. Overrides replace only the named contracts and are included in the approval review/ID. `--schema` governs the final answer and is independent. Keep sensitive data out of schema names, descriptions and enums; result schemas stay local but appear in approval reviews.

A successful handler with invalid JSON data, a schema mismatch, a redaction mismatch or an oversized typed result stops execution with validation exit 4. After an executor validation failure, later handlers and the provider follow-up do not run. The session independently applies the selected credential after the approved batch has returned. A failure detected only at that boundary still blocks the follow-up, but cannot prevent tools that have already completed. The one-use approval is consumed; effects already performed are not rolled back and no automatic retry occurs. Actual handler exceptions remain generic tool errors, allowing other approved calls to continue. A programmatic session alone cannot prove how a supplied result was produced; it validates data and never grants execution rights.

## Approved project file access

The fixed registry now also offers `project_search` for literal path/content search (empty path query lists files) and `project_read` for a line range. Both require exact approval, validate arguments before the approval view and validate results before continuation. File reads/scans start only after approval; safe declarations and review alone perform no file IO. Workspace/ignore/credential/link/size policy applies to direct reads as well as search. See [file contracts and limits](project-files.md).

For task-oriented use, [the composed runtime](../features/task-runtime.md) adds refined prompts, opt-in checkpoint data, cumulative usage and total execution limits to the same adapter/approval/session boundary. It does not authorize tools automatically.
