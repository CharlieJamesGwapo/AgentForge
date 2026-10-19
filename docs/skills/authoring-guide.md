# Skill authoring

A portable skill is a directory containing `skill.json` and a readable `SKILL.md`. Copy the structure of a bundled skill, choose a unique lowercase hyphenated id, describe inputs/outputs and write a concrete procedure, safety constraints, example and acceptance criteria. Avoid executable hooks and provider-specific assumptions.

Install project definitions manually beneath a configured discovery root such as `.agentforge/skills/<id>/`. `skill list` discovers them; `skill inspect <id>` shows their content. Run `skill validate` before sharing. Bundled and local identifiers must be unique; local overrides cannot silently replace shipped definitions.

Capability declarations describe what a human/agent needs to perform the procedure. They do not grant permissions or create tool integrations. Instructions inside a definition remain untrusted data until a human or host agent decides to follow them within its own policy.

See [format](skill-format.md), [validation](validation.md) and [testing](testing.md).
