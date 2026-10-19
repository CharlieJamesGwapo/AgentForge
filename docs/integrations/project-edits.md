# Controlled edit previews

Edit tools read an existing file under the [project file policy](project-files.md), then return a complete diff and before/after SHA-256 hashes. They never execute the proposed text. Unique literal replacements and strict single-file unified patches are supported. Absolute paths, traversal, ignored files, credentials, links, special files, invalid UTF-8 and files larger than 256 KiB are rejected. Configuration and ignore-policy files are protected too.

```sh
agentforge edit capabilities
agentforge edit replace --path src/example.ts --old 'old text' --new 'new text'
agentforge config set permissions.allowTools true
agentforge edit replace --path src/example.ts --old 'old text' --new 'new text' --execute
agentforge edit patch --path src/example.ts --patch-file change.patch --execute
```

The default command previews the requested operation without reading its target. `--execute` asks for exact terminal approval before reading the target and computing the diff. A named patch file is an explicitly supplied local input. Approved tool results may be shared with the selected provider when using `task` or `tools run`; the offline edit CLI needs no credentials or network permission. Piped input cannot approve execution.

Replacement requires one nonempty, uniquely matched section and rejects no-ops. Patch input is limited to 32 KiB, 32 hunks and 2,000 lines. Headers must name exactly the selected existing file. Hunk positions, counts and context must match without fuzzy application. Creation, deletion, renames, modes, binary patches and multiple files are unsupported. UTF-8 BOM and consistent LF/CRLF are preserved; unsupported newline forms fail safely. The complete diff must fit 32 KiB and its serialized preview must fit the 64 KiB tool-result envelope; escaped text can reach the latter limit first. Proposals containing text that would be changed by secret redaction are withheld, rather than approving a different operation from the one displayed.

The registry exposes `project_edit_replace` and `project_edit_patch` as approved read/proposal tools. `project_edit_apply` is present only when `permissions.allowWrite=true`. Proposal state is local to that registry instance, bounded and short lived; it is not stored on disk or reusable in another invocation. An apply request resolves the exact stored path, diff and hashes into a new immutable approval batch. Unknown IDs and a proposal guessed in the same batch fail before approval. An attempted application consumes the proposal.

## File application is unavailable

The current Node backend cannot atomically compare the previewed file version and replace it while excluding writes from external editors. Atomic rename alone does not provide that guarantee; see the [Node filesystem API](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath). As explicitly selected by the user, application fails closed. There is no cooperative-lock override.

`--apply` additionally requires `--execute`, `permissions.allowWrite=true` and a second fresh exact terminal approval. It rereads and compares file identity and bytes: changed content returns `conflict`; an unchanged file returns `unavailable`. Neither path creates a temporary replacement or writes the target. Capability status is inspectable offline with `edit capabilities`. An unavailable application exits 3, a stale conflict exits 4, and permission/approval blocks exit 6. A preview success means a proposed change was computed, not that a file was modified.

Reliable conflict-safe application needs a future filesystem backend with an actual compare-and-replace primitive. No such backend is claimed or simulated in this checkout. Existing configuration and checkpoint writes retain their separate documented behavior.
