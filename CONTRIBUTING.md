# Contributing

This project has no configured hosted repository or verified maintainer list. You can develop locally and prepare a patch; once a real contribution channel exists, use its instructions. Do not invent a repository URL or contact address.

Requires Node 22.13+ (22.x) or 24+ and npm. Run `npm ci`, then `npm run dev -- --help`. Source lives in `src/`; portable definitions live in `skills/`. Keep engines independent of vendor SDKs and terminal UI. Keep changes focused and preserve existing data.

Before proposing a change, run:

```sh
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm run validate:skills
npm run validate:schemas
npm run validate:docs
npm run test:packed
npm audit
```

Add regression tests that prove real behavior and failure paths; avoid paid APIs and nondeterminism. Temporary repositories and real small child processes are preferred to mocks at process/storage boundaries. Do not weaken checks to hide failures. Document unavailable checks honestly.

Git tests create disposable local repositories; synthetic commits in those fixtures do not authorize committing the development checkout. Provider/orchestration tests use native-protocol loopback fixtures and no live credentials. Preserve exact batch approval, scoped permission snapshots and the fail-closed edit backend; a portable rename or cooperative lock is not sufficient proof of conflict-safe application. Report operating systems and provider runtimes actually exercised.

A review should include the concrete problem, resulting behavior, tests executed, compatibility impact and documentation changes. Explain new permissions and dependencies. Review the diff for secrets and generated files. Approval by a real project owner is required before distribution; no automation here publishes packages.

See [skill authoring](docs/skills/authoring-guide.md), [security](SECURITY.md), [governance](GOVERNANCE.md) and the [code of conduct](CODE_OF_CONDUCT.md).

Also run `npm run test:terminal` on macOS/Linux with Python 3 and Git. It installs a fresh tarball, uses loopback providers, and exercises real exact approval, denial and Ctrl+C in pseudo-terminals. Windows CI prepares installation/type smoke coverage only; report untested platform behavior explicitly.

Keep `.editorconfig` conventions, the lockfile and package asset allowlist consistent. Build output, local state, tarballs, scratch logs and implementation reports are ignored; useful reusable plans belong in `docs/development/`, while machine-specific evidence remains local under `outputs/` or `work/`. Run the [release checklist](docs/development/release-process.md) before requesting owner approval. Do not stage, commit, create remotes or distribute this checkout implicitly.
