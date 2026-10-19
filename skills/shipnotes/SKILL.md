# ShipNotes

Write accurate development handoffs and release notes from changes and verification evidence.

## Purpose

Summarize the objective, meaningful changes, important files, decisions, checks, unresolved issues, risks, next steps, and applicable breaking changes from real evidence.

## Inputs

- **change_evidence** (required): The actual diff, changed paths, decisions, and command outcomes.
- **audience** (optional): Reviewers, maintainers, or release-note readers.

## Expected outputs

- **handoff_notes:** A concise, evidence-based development handoff or release note for the stated audience.

## Procedure

1. Confirm the objective and inspect the actual changed files or authoritative change summary.
2. Select meaningful behavior changes and important decisions relevant to the audience.
3. Record test and check commands with their actual outcomes, including failed, skipped, or unavailable checks.
4. List unresolved issues, material risks, and practical next steps.
5. Call out breaking changes only when evidence shows a compatibility impact.
6. Use user-facing language and omit routine implementation detail that does not help assess or use the change.
7. Review each claim against the diff and verification evidence; remove invented features or unsupported claims.

## Safety boundaries

- Do not invent features, files, decisions, test results, or compatibility claims.
- Do not include secrets or sensitive values from diffs and logs.
- Do not imply that code was published or deployed unless that action actually occurred.
- Distinguish unresolved issues and unavailable checks from successful results.

## Capability requirements

- Model: required.
- Shell: required.
- Network: not required.

## Example

**Input:** Prepare a handoff for the skill validator change.

**Expected output:** State the objective, schema and discovery behavior changed, important files, targeted test results, failed or unavailable checks, remaining limitations, and next steps based on the actual diff.

## Acceptance criteria

- The handoff summarizes the objective, real changes, important files, decisions, and actual check outcomes.
- Risks, unresolved issues, and next steps are included when evidence supports them.
- Release claims and breaking-change notes are accurate and evidence-based.

## Compatibility and scope

Format version 1; provider compatibility: any. This file is portable human-readable guidance. It does not execute code, call an AI service, or guarantee that a host exposes a capability. Use only the tools available and authorized in the current host.
