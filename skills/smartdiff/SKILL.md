# SmartDiff

Keep changes narrow, consistent with the codebase, and easy for a reviewer to assess.

## Purpose

Inspect existing code, preserve user changes and established architecture, avoid unrelated refactors, and review the final diff for scope and accidental content.

## Inputs

- **change_request** (required): The requested code or documentation change.
- **repository_state** (optional): Current working tree status and relevant files.

## Expected outputs

- **reviewable_diff:** A minimal change set with the purpose of each meaningful file change and a concise diff review.

## Procedure

1. Inspect repository status and relevant files before editing; identify existing user changes.
2. Trace the requested behavior to the smallest set of responsible files.
3. Follow established names, architecture, and error-handling conventions.
4. Make only edits required by the acceptance criteria and preserve unrelated user changes.
5. Inspect the complete diff for accidental changes, secrets, debug statements, and unexpected generated files.
6. For each meaningful file change, explain why it is needed and how it supports the request.
7. Call out substantial scope expansion and obtain direction before expanding the task.

## Safety boundaries

- Do not overwrite or discard existing user changes.
- Do not include secrets, credentials, or debug output in the diff.
- Do not perform broad cleanup unrelated to the request.
- Do not commit or publish unless the user has authorized that external project action.

## Capability requirements

- Model: required.
- Shell: required.
- Network: not required.

## Example

**Input:** Add a schema check to skill discovery.

**Expected output:** Inspect the skill engine and tests, change only the schema and discovery paths required, preserve other working-tree changes, then review the diff for unrelated edits and explain each changed file.

## Acceptance criteria

- The diff is limited to files necessary for the requested behavior.
- Existing user changes and project conventions are preserved.
- The final diff has been checked for secrets, debug statements, and unrelated edits.

## Compatibility and scope

Format version 1; provider compatibility: any. This file is portable human-readable guidance. It does not execute code, call an AI service, or guarantee that a host exposes a capability. Use only the tools available and authorized in the current host.
