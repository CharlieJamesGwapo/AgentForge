# Roadmap

## Implemented in this development checkout

- Provider-neutral CLI, strict configuration and local project diagnostics.
- Declarative skill discovery/inspection/validation and 13 core skill packages.
- Prompt structuring, conservative compaction and labeled token estimates.
- Explicit local checkpoint save/list/preview/restore.
- Repository file/import graph with ignore handling and bounded scanning.
- Approved subprocess verification, bounded retries and cancellation.
- Test/tooling setup, schemas and prepared GitHub workflows.
- Optional OpenAI Responses, Anthropic Messages and Ollama text adapters, explicit network permission, provider diagnostics and native usage parsing.
- Native streaming, strict portable schema requests and locally validated/redacted structured results across all three model adapters.
- Ordinary and streaming client tool conversations across all three adapters, private argument assembly, exact batch approval, a fixed project-tool registry, approved result continuation and validated structured final answers.
- Local tool-result schemas with raw/redacted validation, approval-bound snapshots, built-in defaults and safe CLI overrides across all three adapters and both modes.

- Bounded project path/content search and line-range reads, local result validation and exact approval; empty path queries provide file listing.
- A composed task runtime with opt-in checkpoint context, explicit provider/model, streaming/final schemas, total deadline/call/output limits and native usage/error/partial-output reports.
- Reproducible packed-install smoke tests against loopback fixtures, included in prepared CI.
- Approved local Git status, bounded existing-file diffs, limited history and local branches, with fixed argv and repository policy.
- Approved unique replacement/strict patch previews, complete bounded diffs, session-bound proposals and stale-file checks; current file application fails closed before writing.
- Optional bounded planner/executor provider conversations, disabled by default, with at most two workers, inherited scoped tools and central approval.

## Planned

- Live-account and real-daemon provider compatibility verification when explicitly authorized; the native text protocols already have local contract tests.
- Host skill-format exporters and external coding-host orchestration adapters.
- A filesystem backend that can guarantee atomic version-checked replacement; the current Node apply path deliberately remains unavailable.
- Additional Git layouts and deleted-file/revision diffs under equally strict repository boundaries.
- Compiler-backed graph resolution and incremental cache invalidation.
- Optional exact tokenizer integration and broader reproducible benchmarks.
- Interactive setup, richer check selection and Windows process-tree verification.
- External review, verified copyright/maintainer details and release approval.

There is no release schedule or promise of hosted services. `run` reruns declared local checks; `orchestrate` separately schedules bounded configured-provider conversations. Model reports remain claims requiring review and verification. Design-oriented and review skills are portable procedures for a human or compatible agent.

## Release preparation and audit status

Implemented regression coverage now includes stable bounded JSON/skill/graph reads, hard-link policy enforcement, write-failure cleanup, terminal-safe model identifiers and scoped credential sanitization. Installed terminal workflows are repeatable through `npm run test:terminal`. Prepared CI adds macOS checks and narrower Windows installation coverage; configured jobs are not evidence of a hosted run.

The MIT license uses collective attribution to AgentForge contributors. Public repository creation and the first push require approval of the exact destination and commit contents; verified maintainer handles and support/private-security routes remain project-owner decisions before a formal release. The intended repository name is **AgentForge**; no GitHub owner, URL or availability has been established. Live providers, full Windows process containment and atomic version-checked source application remain planned work.
