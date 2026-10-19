# Skill format v1

The canonical [JSON schema](../../schemas/skill.schema.json) and runtime validator require metadata, semver version, non-empty inputs/outputs/procedure/safety/examples/acceptance, all capability booleans and compatibility metadata. Each input includes name, required and description; each output includes name and description. Examples include input and output text.

`compatibility` is `{ "formatVersion": 1, "providers": ["any"] }`. `capabilities` declares `requiresModel`, `requiresShell` and `requiresNetwork`. Optional `assets` paths are safe relative references under the skill directory; absolute paths, traversal, missing assets and symlink escapes are rejected. Unknown schema keys fail.

The JSON form is the native interchange format. `SKILL.md` is readable companion guidance; no third-party host import compatibility is claimed. Increment format versions for breaking format changes; skill semantic versions identify instruction changes independently.
