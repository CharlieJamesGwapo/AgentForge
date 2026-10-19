# Dependencies

Use npm with the committed package-lock.json; use `npm ci` in clean environments. Commander handles parsing, Zod handles strict data validation/schema export, ignore handles Git-style rules, and Ajv validates the bounded structured-output schema subset. Tooling dependencies are development-only.

For an update, review upstream primary documentation and license, change the lockfile reproducibly, run project checks and inspect package contents. Run `npm audit` and assess actual affected behavior. Do not automatically upgrade, execute third-party hooks, or claim a security audit is comprehensive merely because a registry scan reports no advisories.

Pin GitHub actions to verified commit SHAs, annotate their versions, and review those pins when updating workflows. No dependency or workflow needs provider credentials for core tests.
