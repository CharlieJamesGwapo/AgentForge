# VerifyLoop and PromptLoop

Configure `verification.checks` as name/command/args records. `verify` previews the exact declaration. Enable `permissions.allowProcess` and pass `--execute --approve` to run it. No implicit shell interpolation occurs; a program explicitly configured as an interpreter is still arbitrary user-privileged execution.

Each process has a timeout and combined output cap. Missing binaries are unavailable; nonzero exits, timeouts and output-limit stops do not pass. Ctrl+C propagates cancellation. The child environment omits provider secrets by default; stdout/stderr are redacted before return. POSIX process groups allow termination of ordinary child trees; see platform limits in [security](../../SECURITY.md).

`run` repeats the checks with configured iteration and total-duration limits. It stops after success, cancellation, the deadline, exhausted attempts or repeated identical failure. It performs no AI calls or code repair; a changing external condition may justify a rerun, but automatic retries do not establish correctness. Inspect the actual results.

On POSIX, termination targets the spawned process group. Deliberately detached descendants can escape that group and outlive the check; output-pipe closure prevents them from keeping the report pending. On Windows only the direct child is terminated. Use OS isolation for full process-tree containment.
