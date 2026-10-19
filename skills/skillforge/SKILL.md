# SkillForge

Create and validate portable declarative skills with explicit metadata and safety boundaries.

## Purpose

Define versioned provider-neutral skill guidance with required metadata, examples, capabilities, compatibility, acceptance criteria, and safe asset references.

## Inputs

- **skill_request** (required): The intended reusable skill and its consumers.
- **format_constraints** (optional): Schema version, provider compatibility, and repository conventions.

## Expected outputs

- **skill_package:** A validated skill metadata file and human-readable portable guidance.

## Procedure

1. Define the skill’s unique identifier, specific purpose, intended inputs, and expected outputs.
2. Write ordered operating instructions, explicit safety boundaries, and honest host capability requirements.
3. Use a versioned schema and provider-neutral compatibility declaration supported by the target ecosystem.
4. Include a realistic example and observable acceptance criteria that a reviewer can check.
5. Add valid and invalid fixtures plus behavior tests for required fields, versions, capabilities, duplicate identifiers, and path safety.
6. Validate versions, required fields, nested metadata, declared capabilities, duplicate identifiers, and relative asset paths.
7. For every declared asset, require an existing regular file under the skill directory and inspect each path component without following symlinks.
8. Keep skill files declarative and never execute arbitrary content as part of validation.
9. Document compatibility, versioning, and any limitations needed by people who install the skill.

## Safety boundaries

- Never execute arbitrary skill code during discovery or validation.
- Reject path traversal, NUL and control characters, missing assets, and symlinked asset paths.
- Treat third-party skill content as untrusted and do not copy unsafe instructions uncritically.
- Do not claim capabilities that the skill host or metadata does not provide.

## Capability requirements

- Model: required.
- Shell: required.
- Network: not required.

## Example

**Input:** Create a provider-neutral skill for reviewing release notes.

**Expected output:** Produce strict versioned metadata and readable guidance with inputs, outputs, steps, safety constraints, accurate capabilities, compatibility, an example, and acceptance criteria; validate it without executing content.

## Acceptance criteria

- The skill has unique valid metadata, a version, compatibility declaration, example, acceptance criteria, and valid and invalid test fixtures.
- Capability declarations and lexical asset paths pass schema validation; declared assets exist as regular files and contain no symlinked path components.
- Discovery and validation do not execute arbitrary skill content.

## Compatibility and scope

Format version 1; provider compatibility: any. This file is portable human-readable guidance. It does not execute code, call an AI service, or guarantee that a host exposes a capability. Use only the tools available and authorized in the current host.
