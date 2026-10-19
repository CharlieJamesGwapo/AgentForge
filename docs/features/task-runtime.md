# Task runtime

`task` composes the existing prompt, context, provider and approved-tool engines. The existing `run` command continues to rerun configured local verification checks. Neither command creates subagents or claims to implement autonomous code editing.

Configure a provider/model using [provider setup](../integrations/providers.md). Then enable network permission and explicitly approve each conversation:

```sh
node dist/cli/index.js config set permissions.allowNetwork true
node dist/cli/index.js task --provider ollama --task "Find and explain the parser" --approve-network --stream
```

This sends a refined engineering brief preserving the objective. If the provider requests tools, the CLI displays the exact immutable batch and stops with exit 6. To enable execution prompts:

```sh
node dist/cli/index.js config set permissions.allowTools true
node dist/cli/index.js task --provider ollama --task "Find and read the parser" --approve-network --stream --execute
```

Type `approve <displayed batch ID>` at a terminal for each batch. Enter declines; Ctrl+C cancels. Piped input cannot approve. Configured verification tools also need `permissions.allowProcess=true`; commands and argv are resolved from configuration and shown before approval. File tools are bounded read-only functions; there is no unrestricted shell, file-write or network tool.

## Explicit input and output

`--model <id>` overrides the configured model for this invocation without persisting a config change. Provider selection is mandatory and there is no fallback. `--with-context` adds only the current checkpoint as untrusted JSON reference data. Without it no checkpoint is loaded into the prompt; no implicit source, environment or skill instructions are uploaded. Local prompt/context redaction is best effort; review what you explicitly elect to share. Tool results require their own approved batch.

`--schema <safe-relative-file>` validates final JSON locally using the [strict subset](../integrations/streaming-structured.md#portable-schema-subset). Pending tool commentary, incomplete finals and all structured text deltas stay private. Successful structured output is serialized from the exact validated/redacted data without another string rewrite. `--result-schemas` separately overrides local tool result contracts; invalid/unsafe files fail before a provider request.

The CLI emits JSON Lines with status, provisional text when allowed, approval and a final `task-result`. Reports include selected/reported model, attempted/completed turns, approved batches/calls, usage, limits, elapsed time and execution outcome. Native token counts are summed only when reported; usage is `partial` when some attempted turns lack valid counts and `unavailable` when none are available. No guessed billing or exact-token estimate is substituted.

On failure, the result includes a normalized safe error and bounded text that was already safely emitted. A failed stream may leave a complete sanitized text prefix; buffered unsafe/incomplete structured content is withheld. This does not persist a resumable provider session or repeat approved tools. Length/refusal are explicit finish reasons and exit 4, not a claim of a successful answer. Policy/approval-required uses exit 6, cancellation 5 and invalid schemas/configuration 2; other provider categories retain their existing exit codes.

## Bounds

- `--max-turns`: 1–10, default 6, including initial/final network turns. Calls on the last allowed turn cannot execute without a follow-up slot.
- At most 16 approved tool calls across the task; each native batch also has the shared 16-call cap.
- `--timeout-ms`: 1–300000 per provider request, default 60000.
- `--max-duration-ms`: 1–600000 for the whole operation, default 120000, including approval waits. Expired or late approval cannot start execution.
- At most 1 MiB accumulated answer/provisional text, 1 MiB per provider response/history, 64 KiB per tool result and the tool-specific smaller file limits. JSON report/event overhead is separate.
- The composed prompt is at most 100000 characters, including explicitly included checkpoint content.

All providers are optional and fixture-tested locally in ordinary/streaming modes. Live hosted account/model and real Ollama compatibility remain unverified. Arbitrary approved processes retain OS privileges; cooperative cancellation cannot undo completed effects or preempt hostile JavaScript. See [security boundaries](../architecture/security-boundaries.md), [tool contract](../integrations/tool-invocation.md) and [file policy](../integrations/project-files.md).

The fixed registry additionally offers approved [Git inspection](../integrations/git-inspection.md) and [edit previews](../integrations/project-edits.md). Apply remains unavailable on the current backend. Separate [orchestration](orchestration.md) reuses this runtime for bounded workers, with trusted configuration snapshots, a downward output budget and scoped tools; the standalone `task` command keeps its existing defaults and does not delegate.
