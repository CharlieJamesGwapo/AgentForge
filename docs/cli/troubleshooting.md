# Troubleshooting

If config is missing, run `init` in the correct project or specify `--cwd`. If config is malformed, repair it using the schema; `init` deliberately refuses to overwrite it. Unknown keys and out-of-range limits fail validation.

Execution blocked: first inspect `verify`, then set `permissions.allowProcess` to true if appropriate, and pass both `--execute --approve`. Approval is for arbitrary user-privileged processes; review commands and their scripts. A missing executable is unavailable, not a passing check. No configured checks is an error for execution.

A damaged checkpoint causes a clear failure. Inspect the specific JSON under `.agentforge/checkpoints/` using the checkpoint schema, or archive that local file manually. No repair or deletion occurs automatically.

Model requests need a configured provider with a real model, its credential environment variable (hosted services), `permissions.allowNetwork=true`, `--model --provider <id>` and `--approve-network`. Offline readiness does not prove connectivity or model access; use an explicitly approved connection check. A missing key, rate limit or unsupported model is reported without switching providers. Report only sanitized reproduction details via a verified owner route; see [support](../../SUPPORT.md).
