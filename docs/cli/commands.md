# Command reference

Run `agentforge --help` or `agentforge <command> --help` for flags. From source use `npm run dev -- <command>`; after building use `node dist/cli/index.js <command>`.

| Command                                                    | Behavior                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| init                                                       | Create defaults without overwriting existing configuration                                     |
| doctor                                                     | Report runtime, optional Git, config and permission health                                     |
| status                                                     | Report project config, skill activation, checkpoints and adapter health                        |
| config / config get key / config set key value             | Inspect and safely edit validated settings                                                     |
| prompt --task text                                         | Add an engineering brief around the original objective                                         |
| prompt --task text --compact                               | Remove exact adjacent duplicate prose lines; report estimates                                  |
| prompt --task text --model --provider id --approve-network | Explicit configured-provider inference, requiring network permission                           |
| context                                                    | Show current context and checkpoints                                                           |
| context save --name label                                  | Store explicit objective/summary/decision/next text                                            |
| context list                                               | List checkpoint contents and ids                                                               |
| context restore id                                         | Preview content and effects                                                                    |
| context restore id --apply                                 | Replace `.agentforge/context.json` only                                                        |
| skill list / skill inspect id / skill validate             | Discover and validate inert bundled/project skills                                             |
| graph                                                      | Map files and supported local JS/TS import edges                                               |
| verify                                                     | Preview configured checks                                                                      |
| verify --execute --approve                                 | Run trusted checks if policy allows                                                            |
| run                                                        | Preview bounded check workflow                                                                 |
| run --execute --approve                                    | Rerun approved checks within configured limits                                                 |
| task --provider id --task text --approve-network           | Refined task runtime with optional checkpoint and exact tool approval                          |
| tools list                                                 | Inspect fixed project tool declarations offline                                                |
| tools run --provider id --task text --approve-network      | Request calls; --execute asks for exact terminal approval per batch                            |
| git status / diff --path file / log --limit count / branch | Preview local Git inspection; --execute requires exact terminal approval                       |
| edit capabilities                                          | Report the current filesystem backend and unavailable application guarantee                    |
| edit replace --path file --old text --new text             | Preview a bounded unique replacement; --execute approves reading and diff generation           |
| edit patch --path file --patch-file patch                  | Preview a strict single-file patch; --apply needs a second approval and currently fails closed |
| orchestrate status                                         | Inspect disabled/enabled state, roles, permissions and budgets offline                         |
| orchestrate plan --task text --approve-network             | Request and validate a strict plan without workers                                             |
| orchestrate run --task text --approve-network              | Schedule at most two bounded worker conversations with inherited scoped tools                  |

Global flags: `--cwd directory`, `--json`, `--verbose`, `--help`, `--version`. Reports currently use readable JSON in either output mode; help/version are text. Errors use JSON on stderr; successful reports use stdout. `--verbose` adds the error category without exposing stack traces or credentials.

`context save` accepts `--objective text`, `--summary text`, `--decision text...` and `--next text...`. No implicit source capture occurs. `--apply` is explicit consent to replace active context. [Exit codes](exit-codes.md) distinguish argument/policy/capability/verification failures.

Optional providers: `provider list` and `provider check <id>` inspect readiness offline. `provider check <id> --connect --approve-network` makes a non-inference connection check if `permissions.allowNetwork` is true. `prompt --model --provider <id> --task <text> --approve-network` sends that explicit task and any explicitly selected schema. Both network paths accept `--timeout-ms`; a configured model is required and no provider is selected automatically. See [provider setup](../integrations/providers.md). Partial/refused generation returns its explicit finish reason and exit 4. `--compact` is a separate local operation and cannot be combined with `--model`.

Model requests also accept `--stream` for JSON Lines and `--schema <relative-file>` for locally validated JSON. Both require `--model` and the existing network approval. Structured streams emit only a validated terminal result; text streams emit redacted complete lines as provisional events. See [streaming/schema guide](../integrations/streaming-structured.md).

`tools run --provider <id> --task <text> --approve-network --stream` streams provider-neutral provisional text and returns validated tool turns. Add `--execute` only after enabling tool permission; every complete batch still needs its exact ID typed at a terminal. Partial arguments never appear as executable calls, and malformed/truncated/cancelled streams never reach approval. See [tool invocation](../integrations/tool-invocation.md).

`tools run --schema <safe-relative-file>` combines tool requests with validated structured final answers, in either ordinary or `--stream` mode. Tool turns report structured output pending; valid finals return parsed data; refusal/length report unavailable. Schema-mode streams suppress text deltas. Invalid schema files fail before a request, invalid final data exits 4 without its payload, and exact batch approval remains mandatory. See the [combined contract](../integrations/tool-invocation.md#combining-tools-and-a-structured-final-answer).

`tools run --result-schemas <safe-relative-file>` loads a local map of registered tool names to result schemas before any request. Built-ins validate their results by default; overrides appear in the exact approval review. This is separate from final-answer `--schema`. Both ordinary and streaming continuations reject invalid typed results with exit 4 before follow-up. Executor validation failures stop later handlers, and consumed approvals are not retried. See [tool-result validation](../integrations/tool-invocation.md#validating-tool-results).

`task --task <text> --provider <id> --approve-network` composes a refined prompt and a bounded model/tool conversation. `--with-context` explicitly includes the current checkpoint; `--model <id>` overrides the configured model for one run. It supports `--stream`, `--schema`, `--result-schemas`, `--max-turns`, `--timeout-ms` and `--max-duration-ms`. Execution requires `--execute`, tool permission and each exact approval ID typed on a terminal. JSON Lines include status, provisional text when allowed, approval and `task-result` events. Failure results preserve only safely delivered partial text; no schema-mode partial JSON is exposed. See [task usage](../features/task-runtime.md).

`project_search` and `project_read` are tool declarations requested through `task` or `tools run`, rather than unrestricted filesystem CLI commands. `tools list` shows schemas offline. The [file guide](../integrations/project-files.md) describes literal search, empty-query listing, line windows, exclusions and bounds.

The [Git guide](../integrations/git-inspection.md) explains fixed operations, process permission, approved existing-file diffs and unsupported repository layouts. The [edit guide](../integrations/project-edits.md) describes unique replacement, strict patch validation, complete diff review and the fail-closed file application policy. Neither CLI needs model credentials. Default invocations preview requested operations; `--execute` requires tool permission and a fresh exact ID typed at a terminal.

`orchestrate` requires enabled configuration, explicit roles and network permission/consent. `--planner`, `--executor`, `--planner-model` and `--executor-model` override role selections for one invocation; `--no-subagents` prevents worker dispatch. `--execute` enables central serialized terminal approval for every worker tool batch; it grants no authority by itself. See [orchestration usage](../features/orchestration.md). `run` retains its existing local-check behavior.
