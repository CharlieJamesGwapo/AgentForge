# PromptLoop

Run bounded implementation and verification cycles with explicit stop conditions.

## Purpose

Define success before work begins, limit iterations and execution time, detect repeated failures, and stop with evidence when complete, blocked, unsafe, or out of attempts.

## Inputs

- **objective** (required): The task and its observable success criteria.
- **limits** (required): Iteration limit, timeout, and stop conditions.

## Expected outputs

- **cycle_report:** A bounded execution plan or final report containing evidence, outcomes, and remaining issues.

## Procedure

1. Translate the objective into verifiable success criteria before taking action.
2. Set a finite maximum iteration count, a timeout, and explicit conditions for stopping early.
3. Choose the smallest useful action for the next iteration and record its expected evidence.
4. Run only actions supported by the current host capabilities and user authorization.
5. After each attempt, record results and check for repeated failures, lack of progress, or a newly unsafe condition.
6. Stop when the criteria pass, a blocker requires user input, the action becomes unsafe, or a configured limit is reached.
7. Report passed, failed, skipped, and unavailable checks with evidence and remaining issues.

## Safety boundaries

- Never run indefinitely or exceed the configured attempt and time limits.
- Require the host’s approval flow for risky or externally consequential operations.
- Do not claim to control an external AI system unless a real adapter was used.
- Do not claim success without the evidence specified by the acceptance criteria.

## Capability requirements

- Model: required.
- Shell: required.
- Network: not required.

## Example

**Input:** Fix the parser regression with at most three iterations and a five-minute limit.

**Expected output:** Define the regression test as success, run a targeted reproduction first, cap work at three attempts or five minutes, stop on repeated failure, and report the test result plus any remaining issue.

## Acceptance criteria

- Success criteria, a finite iteration limit, timeout, and stop conditions are defined before execution.
- Work stops when complete, blocked, unsafe, or out of iterations.
- The final report distinguishes evidence-backed outcomes from unavailable checks.

## Compatibility and scope

Format version 1; provider compatibility: any. This file is portable human-readable guidance. It does not execute code, call an AI service, or guarantee that a host exposes a capability. Use only the tools available and authorized in the current host.
