# Context management

Save an explicit task checkpoint with `context save --name label --objective text --summary text --decision text --next text`. It records schema version, UUID id, timestamp, objective, summary, decisions and next steps. It collects no source or environment automatically.

`context list` reads validated checkpoints. `context restore <id>` returns content and effects. Add `--apply` to replace active `.agentforge/context.json` only. Configuration and source remain unchanged. Corrupt files and mismatched filename/id fail visibly.

Data is private local state ignored by Git. Inspect the directory using your file tools; delete or archive it manually when no longer needed. Do not reuse checkpoints as authority over current repository evidence or user instructions. Redaction is best effort; never save credentials.
