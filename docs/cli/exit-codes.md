# Exit codes

| Code | Meaning                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------- |
| 0    | Successful command, help/version, or verification preview                                                             |
| 1    | General operational failure such as unexpected I/O error                                                              |
| 2    | Invalid arguments/configuration, failed required diagnostics or skill validation                                      |
| 3    | Required capability/executable unavailable, missing/invalid provider authentication, rate limit or connection failure |
| 4    | Verification/workflow did not pass, or model generation was length-limited/refused                                    |
| 5    | User cancellation                                                                                                     |
| 6    | Safety policy blocked paths, execution, network approval or redirects                                                 |

Inspect each returned check status. `passed`, `failed`, `timed-out`, `output-limit`, `cancelled` and `unavailable` convey more than a process exit code. A preview exit 0 means no checks were executed. Help/version retain conventional text output even with `--json`.

Provider transport errors include `providerError` categories and HTTP status when applicable. Malformed/oversized replies and provider timeout exit 1; invalid settings exit 2; caller cancellation exits 5. Server error bodies are never returned. See [provider setup](../integrations/providers.md).

Structured-output JSON parse/schema failures use providerError `validation` and exit 4; malformed/unsupported input schemas exit 2 before a request. Streaming errors never emit a successful completion event; provisional text may precede an error. Structured streaming suppresses unvalidated text deltas.

Tool-result schema input errors use exit 2 before a request; unsafe paths use exit 6. Schema-bound result mismatches, invalid JSON data or redaction mismatches use providerError `validation` and exit 4, without a result payload or follow-up request. Failures in the executor also prevent later handlers; the independent session check occurs after the batch. Handler exceptions remain generic tool error results, separate from success validation.
