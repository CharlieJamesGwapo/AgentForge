# Validation

`agentforge skill validate` validates bundled and configured project discovery roots. `npm run validate:skills` validates the bundled catalog from the development checkout. The engine checks required metadata, identifier/version syntax, capabilities, compatibility, duplicate ids, relative asset paths and bounded JSON reads. It does not evaluate whether a procedure's advice is correct.

Validation never executes a skill's text or assets. Missing optional discovery roots are skipped; malformed present files fail rather than disappear. Inputs are subject to size/scan limits and symlink rejection. Review instructions and examples independently before using them with a coding agent.
