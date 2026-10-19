# ADR 1: A local modular package

Status: adopted for initial development.

Use one strict TypeScript package with module boundaries instead of separately published packages. This keeps installation and lockfile-based verification simple while allowing engines and adapter contracts to evolve independently. A split becomes useful when actual independent consumers or release cycles exist.

Use JSON with strict Zod validators and exported JSON schemas. Skill text is portable data, not a plugin execution mechanism. Preserve provider neutrality by shipping no provider SDK and reporting missing remote capabilities honestly. Choose local explicit checkpoints instead of capturing environment/source data automatically.
