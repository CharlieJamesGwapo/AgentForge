# TokenSaver

Compress project context while preserving decisions, constraints, and evidence needed to continue work.

## Purpose

Remove repetition and stale details from long context while retaining important paths, identifiers, errors, decisions, current instructions, safety rules, and acceptance criteria.

## Inputs

- **context** (required): Conversation, project notes, or prompt to condense.
- **target** (optional): Desired length or the next task that will use the summary.

## Expected outputs

- **compact_context:** A concise, resumable context summary with original and optimized character counts, comparable token counts or estimates when available, preserved constraints, intentionally removed information, and the measurement method.

## Procedure

1. Identify the current objective and the next action that the summary must support.
2. Extract concrete paths, identifiers, error messages, decisions, constraints, acceptance criteria, and unresolved issues.
3. Remove duplicated explanations, stale assumptions superseded by newer evidence, and details irrelevant to the next action.
4. Keep safety boundaries and required acceptance criteria intact even when they consume space.
5. If character or token measurement is available, measure both inputs and outputs with the same method.
6. Label token counts as estimates when using a heuristic or when the exact tokenizer is unavailable.
7. Compute a reduction percentage only when original and optimized measurements use comparable units and methods.
8. Return original and optimized character counts, token counts or estimates when available, preserved constraints, intentionally removed information, and the measurement method.

## Safety boundaries

- Never claim exact token counts without the exact tokenizer and measurement method.
- Never invent token-savings percentages or remove safety and acceptance requirements for brevity.
- Treat current user instructions and repository evidence as more authoritative than stale summaries.

## Capability requirements

- Model: required.
- Shell: not required.
- Network: not required.

## Example

**Input:** A long thread repeats that src/api.ts is out of scope and records a failing timeout test.

**Expected output:** Keep the objective, the out-of-scope path, the exact timeout failure, the decision already made, and the next test to run; remove repeated background. If tokens are estimated, label the estimate and tokenizer limitation.

## Acceptance criteria

- The next person can resume the stated objective without reopening removed context.
- Important paths, identifiers, failures, decisions, constraints, and safety rules remain accurate.
- The report includes character counts, comparable token counts or labeled estimates, preserved constraints, removed information, and measurement method when measurements are available.
- Any approximate measurement is clearly labeled and no percentage is fabricated.

## Compatibility and scope

Format version 1; provider compatibility: any. This file is portable human-readable guidance. It does not execute code, call an AI service, or guarantee that a host exposes a capability. Use only the tools available and authorized in the current host.
