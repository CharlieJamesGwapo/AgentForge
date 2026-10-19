# Release preparation

The public source repository is [CharlieJamesGwapo/AgentForge](https://github.com/CharlieJamesGwapo/AgentForge), with default branch `main`. The development package remains unpublished and has `private: true` to block npm publication. Public source availability does not imply a versioned release or deployment. New commits, pushes, tags, releases, npm publication and deployment require explicit authorization for the relevant action.

## Repository contents

Keep the existing focused module layout: `src/cli`, `src/core`, `src/engines`, `src/adapters`, `src/shared`, `skills`, `schemas`, `tests`, `docs`, `examples`, `scripts` and `.github`. The CLI has one bin entry, compiled declarations and no supported library exports. Do not move modules solely for appearance.

Version-control useful architecture decisions, development plans, fixtures, source, schemas and documentation. Keep `node_modules/`, `dist/`, `.agentforge/`, `work/`, `outputs/`, logs, tarballs and environment files local. Existing implementation reports under `outputs/` are retained as historical evidence; their machine-specific paths, per-session details and stale test counts do not belong in package documentation. Never delete useful evidence merely to clean the tree.

The package file allowlist includes runtime code/declarations/source maps, source, skills, schemas, examples, root Markdown and docs. It excludes tests, workflow files, historical implementation plans, scratch data, local state, dependencies and reports. Developer testing, dependency-management and release guides remain packaged; local historical plans can remain outside the reviewed commit. The explicit source inclusion keeps relative source-map targets available. Review the actual tarball every time the allowlist changes.

## Local checks

```sh
npm ci
npm run check
npm audit
npm run test:packed
npm run test:terminal
mkdir -p work/package
npm pack --dry-run --json > work/package/dry-run.json
```

The terminal suite requires macOS/Linux, Python 3 and Git. It installs a fresh tarball and uses pseudo-terminals for real exact approval, denial and Ctrl+C. Both installation suites use the local npm cache and loopback native-protocol providers, never live inference. Cache absence is a failed prerequisite, not a successful smoke check.

Inspect package name/version/engine/bin and runtime asset paths, lockfile consistency, archive contents, machine-specific paths and potential secrets. Basic installed help/version/status/skills must work without credentials. A heuristic local scan is not a guarantee of no secrets; inspect any matches privately and run a dedicated offline secret scanner when available. Do not upload source to an unapproved service.

Review `git status`, the complete unstaged diff (including untracked files) and the staged diff without changing user staging. Inspect history and remotes before proposing a commit. Synthetic commits in disposable test repositories are isolated test fixtures.

## GitHub workflows

| Workflow               | Trigger and scope                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`               | Push/PR/manual: full checks, packed install and POSIX terminal tests on Linux Node 22/24 and macOS Node 24; narrower Windows Node 24 typecheck/packed-install job |
| `security.yml`         | Push/PR/manual: locked dependency installation and `npm audit --audit-level=high`                                                                                 |
| `skill-validation.yml` | Push/PR/manual: bundled skill validation                                                                                                                          |
| `docs-validation.yml`  | Push/PR/manual: local documentation-link validation                                                                                                               |
| `release.yml`          | Manual only: checks, local package build and temporary development-artifact upload                                                                                |

All jobs use read-only repository permission, pinned action commits and checkout without persisted credentials. No workflow requires provider keys or uses `pull_request_target`. All four push workflows passed at commit `86cce82` on 2026-10-19; see [recorded results](testing.md#verified-hosted-ci). Recheck results for each proposed commit. The manual artifact workflow is separate from those four verified runs. Windows installation checks do not establish full process-tree, filesystem or terminal support.

The artifact workflow does not create a release, push a tag or publish to npm. Its artifacts remain development builds. Push/PR workflows are active in the public repository. Local documentation review does not create a remote run.

## Required owner decisions and authorization

The MIT license uses the collective attribution “AgentForge contributors,” adopted during initial-commit review. This wording names contributors collectively and does not establish an organization or individual maintainer identity. Review rights to all included contributions before distribution; confirm ownership/maintainer consent and establish suitable security/support routes before a formal release. Do not guess identities or channels. CODEOWNERS requires verified GitHub handles and repository access; funding configuration requires a verified destination and authorization.

Use the existing verified destination `https://github.com/CharlieJamesGwapo/AgentForge.git`; do not create a replacement repository or remote as part of local review. After the owner explicitly authorizes a commit, review exactly the selected files and create it without rewriting history. Before any push, show the verified destination URL, source/target branches, exact commits, verification evidence and any remaining release blockers, then obtain approval for that push. A proposed PR title/description is a draft until an actual PR is created. npm publication, GitHub release creation and deployment each remain separately unauthorized.
