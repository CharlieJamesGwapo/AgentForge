# Bounded planner and executor conversations

The built-in orchestration engine uses the existing optional provider adapters. A planner returns a locally validated task plan, then at most two workers run bounded `task` conversations. Roles are configuration references to providers/models, without vendor-specific orchestration logic. This is not an integration with external coding-host agents. No claim of live-account or real-daemon compatibility is made; tests use loopback native-protocol fixtures.

## Explicit setup

Configure a provider/model using the [provider guide](../integrations/providers.md), then inspect the default disabled state:

```sh
agentforge orchestrate status
agentforge config set orchestration.planner '{"provider":"ollama"}'
agentforge config set orchestration.executor '{"provider":"ollama"}'
agentforge config set orchestration.enabled true
agentforge config set permissions.allowNetwork true
agentforge orchestrate plan --task "Plan an explanation of the parser" --approve-network
agentforge orchestrate run --task "Inspect and explain the parser" --approve-network
```

These examples require an explicitly configured Ollama endpoint/model; either role may instead reference another configured provider. The role's optional `model` overrides its provider default. Invocation flags `--planner`, `--executor`, `--planner-model` and `--executor-model` choose explicit roles/models for that invocation. Nothing selects a provider or fallback automatically. Missing roles, unsupported capabilities, disabled configuration or absent network consent block execution.

`plan` requests a plan without starting workers. `--no-subagents` narrows a run by preventing worker dispatch; it cannot override disabled project policy. `maxDepth: 0` also prevents worker dispatch. Workers have no delegation tool or CLI execution facility, and a nested invocation cannot exceed the configured depth. `orchestration.enabled` defaults false and old configuration files load with it disabled.

## Plans, scopes and budgets

The planner receives the explicit task and a strict portable output schema, without tools or automatic source/checkpoint uploads. Each subtask has an ID, task text, context text and project-relative path scopes. Semantic validation rejects invalid paths/duplicate IDs and excessive task, context and plan sizes before dispatch. A worker receives only its explicit subtask material as untrusted JSON reference data. Source reads require separate tool approval.

Defaults and bounds:

| Setting         | Default | Allowed   |
| --------------- | ------- | --------- |
| maxConcurrency  | 2       | 1–2       |
| maxDepth        | 1       | 0–1       |
| maxSubtasks     | 8       | 1–8       |
| maxContextBytes | 16384   | 256–32768 |
| maxOutputBytes  | 32768   | 256–65536 |
| timeoutMs       | 60000   | 1–300000  |
| maxDurationMs   | 300000  | 1–600000  |

Context counts UTF-8 bytes of serialized `{task, context, paths}` per subtask; fixed prompt framing is separate. Planner output and each worker answer have finite output budgets. Existing transport, turn, tool-call and result limits still apply. The total deadline covers planning, queues, approval waits and workers. Cancellation or late approval cannot start another tool action. Completed sibling results remain available when another worker fails or times out.

Worker finals must match `{status, summary, paths}` and pass host semantic checks. `completed` records a validated conversation outcome and remains a model claim, not proof of implementation or tests. Overlapping assigned scopes and returned path claims produce conflicts. Out-of-scope claims fail the worker; lexically safe rejected paths remain separately labeled for conflict analysis. The report retains failures, partial completion and conflicts; it never automatically merges proposals or verifies claimed changes.

## Central approval and permissions

Configuration, roles and permissions are snapshotted before planning. Workers receive a host-owned restricted tool registry and cannot supply handlers, expand permissions or reload a changed policy to gain authority. Read/search/preview/diff requests must stay within assigned scopes. Repository-wide Git metadata needs a whole-project scope. Arbitrary configured verification processes are excluded from worker registries because they could run a nested CLI or expand authority; run checks separately after reviewing results.

To enable approval prompts, set `permissions.allowTools=true` and add `--execute`. Every worker batch is centrally serialized, identifies its subtask/provider/model and requires its exact ID typed at a terminal. There are no parallel competing prompts or piped approvals. Process permission still gates Git tools. Workers receive edit previews only; `project_edit_apply` is excluded from their registry. [File application remains unavailable](../integrations/project-edits.md) in standalone edit/task tools too, including after a fresh exact apply approval.

Reported usage uses native counters only; missing counters remain unavailable or partial. Bounded output is an application safeguard, not a billing limit or operating-system sandbox. No tools execute in the planner, no edited code runs automatically, and no network tool or external agent launcher is exposed to workers.
