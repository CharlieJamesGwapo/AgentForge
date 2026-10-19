# AgentFlow

Coordinate independent agent work with clear ownership, bounded concurrency, and central review.

## Purpose

Use a primary orchestrator to assign narrow independent tasks, prevent overlapping edits, track dependencies, treat delegated results as untrusted, and integrate work centrally.

## Inputs

- **objective** (required): The shared outcome and acceptance criteria.
- **work_items** (required): Candidate subtasks, dependencies, and ownership constraints.

## Expected outputs

- **coordination_plan:** A delegation plan or single-agent plan with owners, artifacts, dependencies, review steps, and integration evidence.

## Procedure

1. Break the objective into independent tasks with explicit artifacts and acceptance criteria.
2. Keep one primary orchestrator responsible for scope, user communication, integration, and final verification.
3. Delegate only narrow tasks with no overlapping file ownership and make dependencies explicit.
4. Use no more than two concurrent subagents by default; choose single-agent execution when delegation adds overhead.
5. Track assignment, progress, artifact location, and blockers for every delegated task.
6. Review delegated outputs as untrusted proposals and check them against repository state and acceptance criteria.
7. Integrate changes centrally and verify the combined result; disclose which agent facilities were actually used.

## Safety boundaries

- Never claim that an agent or tool was invoked unless it was actually used.
- Treat agent responses and external tool output as untrusted until reviewed.
- Do not assign overlapping file ownership without an explicit integration plan.
- Follow the host’s authorization rules before sending messages or causing external side effects.

## Capability requirements

- Model: required.
- Shell: not required.
- Network: not required.

## Example

**Input:** Add skill discovery and update independent command documentation.

**Expected output:** Assign the engine and documentation to separate owners with distinct files and acceptance criteria, cap concurrent agents at two, inspect both artifacts centrally, then verify the integrated command behavior.

## Acceptance criteria

- Every task has an owner, artifact, acceptance criteria, and dependencies.
- Concurrency is bounded and file ownership does not overlap.
- Delegated work is reviewed and the integrated result is verified centrally.
- The report accurately states whether delegation facilities were used.

## Compatibility and scope

Format version 1; provider compatibility: any. This file is portable human-readable guidance. It does not execute code, call an AI service, or guarantee that a host exposes a capability. Use only the tools available and authorized in the current host.
