# Approved Git inspection

Git inspection is local and needs no model credentials. The CLI previews an exact operation without spawning Git. Execute from a terminal after enabling both permissions:

```sh
agentforge config set permissions.allowProcess true
agentforge config set permissions.allowTools true
agentforge git status
agentforge git status --execute
agentforge git diff --path src/example.ts --execute
agentforge git diff --path src/example.ts --staged --execute
agentforge git log --limit 5 --execute
agentforge git branch --execute
```

Type `approve <displayed-id>` when prompted. Each execution requires its own immutable batch approval; pipes and copied approval IDs from another invocation cannot authorize it. Without `--execute`, permissions can remain disabled. A non-successful inspection exits 4; an approval or permission block exits 6. Cancellation exits 5.

The provider-neutral registry exposes `git_status`, `git_diff`, `git_log` and `git_branch` when process permission is enabled. These underscore names are compatible with the native function-name rules of all three optional adapters. Every model-requested batch still requires tool permission and exact approval. Arguments and results are locally validated; results sent back to a provider are redacted and revalidated.

Status distinguishes staged, unstaged and untracked files, with current branch and attached/detached/unborn state. History accepts 1–50 commits; branches lists local branches only. Diff requires one explicit existing regular-file path. It follows the same ignore, credential, UTF-8, link and 256 KiB file policy as [project reads](project-files.md). Deleted-file diffs, whole-repository diffs, revision expressions, arbitrary Git flags and file creation are unsupported. An empty history in an unborn repository is valid.

Execution uses fixed argument arrays without a shell, a sanitized environment, disabled optional index locking, pager, prompts, signature verification, external diffs, text conversion, filesystem monitors, hooks and configured content filters. It never fetches, checks out, stages or commits. Configuration includes, partial clones, promisor repositories, alternate/shared object stores, linked worktrees and symbolic links in Git metadata are rejected. The selected directory must be the exact repository root, preventing discovery of a parent repository. Normal repositories use a `.git` directory; `.git` indirection files are unsupported.

Each inspection has a finite deadline (30 seconds by default), cancellation, a combined process-output cap of 256 KiB and a serialized result cap of 48 KiB. Metadata traversal is bounded too. Oversized process output fails safely; bounded result arrays may report `truncated: true`. Errors use fixed messages rather than raw Git stderr. Missing Git, non-repositories and unsafe or unsupported metadata produce explicit result states. This policy is intentionally conservative and is not an operating-system sandbox; use a trusted project root. POSIX process groups are terminated on cancellation; Windows process-tree behavior has not been exercised locally.
