# VerifyLoop

Check requested behavior with relevant tests and report results accurately.

## Purpose

Select evidence appropriate to acceptance criteria, run targeted checks before broader checks, and distinguish passed, failed, skipped, and unavailable verification.

## Inputs

- **change** (required): The implementation or behavior to verify.
- **acceptance_criteria** (required): The expected observable outcomes.

## Expected outputs

- **verification_report:** A record of relevant checks, commands, outcomes, evidence, and remaining limitations.

## Procedure

1. Map each acceptance criterion to the strongest practical observable check.
2. Inspect the project’s existing test and check commands before selecting commands to run.
3. Run the most targeted relevant test or reproduction first and retain its actual exit status and output.
4. Run broader tests, formatting, lint, type checks, builds, or security checks when supported and proportionate.
5. Add a regression test for a bug fix when practical, and never weaken tests to force a pass.
6. Mark each check as passed, failed, skipped, or unavailable with concise evidence.
7. Report remaining issues and avoid treating one successful build as proof of full correctness.

## Safety boundaries

- Never claim a check passed unless it completed successfully and produced confirming evidence.
- Do not weaken or delete tests merely to make a change pass.
- Do not run destructive or externally consequential checks without the host’s required approval.
- Do not expose secrets from test output in the report.

## Capability requirements

- Model: required.
- Shell: required.
- Network: not required.

## Example

**Input:** Verify a fix for duplicate skill IDs.

**Expected output:** Run the duplicate-ID regression test first, then relevant schema tests and type checking; report the command and real result for each, and state any unavailable broader check.

## Acceptance criteria

- Checks are tied to acceptance criteria and target the change directly.
- Passed, failed, skipped, and unavailable outcomes are distinguished.
- No correctness claim exceeds the evidence collected.

## Compatibility and scope

Format version 1; provider compatibility: any. This file is portable human-readable guidance. It does not execute code, call an AI service, or guarantee that a host exposes a capability. Use only the tools available and authorized in the current host.
