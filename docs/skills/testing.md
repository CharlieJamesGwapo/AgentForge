# Skill testing

Each bundled skill has explicit acceptance criteria and an input/output example. Structural tests validate all 13 definitions, reject bad versions/capabilities/traversal and duplicate ids, and prove text remains inert. Fixtures live under `tests/fixtures/skills/`.

For procedural quality, use a small representative task, record the actual host/model/tools used, and compare the result against the skill's acceptance criteria. Never claim an AI reasoning skill has been empirically validated just because its JSON passes. Native prompt, graph, checkpoint and verification engines have separate deterministic tests. No paid model or external agent host is used in the automated suite.
