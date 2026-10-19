# PromptForge

`prompt --task '<request>'` preserves the request as the objective and wraps it in a reusable engineering brief: context inspection, scope, constraints, implementation plan, acceptance, testing, risks and unresolved questions. The command is a deterministic template, not model reasoning or repository-specific analysis.

Assumptions are reported explicitly. You should replace generic acceptance criteria with concrete behavior after inspecting the project. The PromptForge skill provides a richer procedure for a human or capable agent. `--model --provider <id> --approve-network` instead submits the explicit task text and optional selected schema to a configured provider when network permission is enabled. It does not send the local template, source files or checkpoints. Completion state and native usage are returned explicitly; see [provider setup](../integrations/providers.md).
