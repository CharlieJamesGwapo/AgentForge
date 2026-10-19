# ContextPilot

Maintain local, resumable project checkpoints that reflect current evidence and decisions.

## Purpose

Create and inspect concise project checkpoints containing the objective, progress, architectural decisions, completed work, failures, and next steps.

## Inputs

- **project_state** (required): Current objective, repository evidence, decisions, and progress.
- **checkpoint_action** (required): Save, list, inspect, or restore a checkpoint.

## Expected outputs

- **checkpoint_result:** A validated local checkpoint or a clear checkpoint inspection and restore summary.

## Procedure

1. Gather the current objective and confirm progress against repository state and the latest user instructions.
2. For a save, record a concise summary, completed tasks, important decisions, failed checks, unresolved issues, and next steps.
3. For a list request, show available checkpoint identifiers and safe summary metadata without exposing stored secrets or full source contents.
4. For an inspect request, validate the selected checkpoint and show its objective, progress, decisions, failures, and next steps.
5. Validate the checkpoint against its versioned schema before saving or restoring it.
6. Keep checkpoint data local by default and store only the minimum context needed to resume.
7. Exclude credentials, secret values, and large source files; refer to paths instead of copying contents.
8. When restoring, compare the checkpoint with current repository state and label stale information before relying on it.
9. Report the checkpoint action and any validation or restoration issues.

## Safety boundaries

- Do not silently store credentials, secrets, or large source files.
- Treat current user instructions and repository state as more authoritative than old checkpoint content.
- Do not claim persistence unless a host-provided local save operation succeeded.
- Do not overwrite a checkpoint on a conflicting path without the host’s required approval.

## Capability requirements

- Model: required.
- Shell: not required.
- Network: not required.

## Example

**Input:** Save a checkpoint after the parser tests fail on an invalid version field.

**Expected output:** Record the parser objective, completed schema work, exact failing test, relevant decision, current files, and next debugging step; exclude environment secrets and label the test failure as unresolved.

## Acceptance criteria

- A saved checkpoint includes the current objective, progress, decisions, failures, and next steps.
- Checkpoint data is version-validated and contains no credentials or copied source bundles.
- Restore results distinguish current repository evidence from stale checkpoint claims.

## Compatibility and scope

Format version 1; provider compatibility: any. This file is portable human-readable guidance. It does not execute code, call an AI service, or guarantee that a host exposes a capability. Use only the tools available and authorized in the current host.
