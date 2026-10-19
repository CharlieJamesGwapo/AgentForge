# Portable skills

All 13 bundled skills are declarative, provider-neutral procedures with metadata, ordered steps, safety boundaries, examples and acceptance criteria. Native CLI engines implement selected mechanical operations; the full reasoning/design/review procedures need a human or compatible agent. Loading a skill never executes code.

| Skill                                            | Purpose                                                                                                         | Declared requirements                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| [AgentFlow](skills/agentflow/SKILL.md)           | Coordinate independent agent work with clear ownership, bounded concurrency, and central review.                | Model-assisted reasoning                    |
| [ContextPilot](skills/contextpilot/SKILL.md)     | Maintain local, resumable project checkpoints that reflect current evidence and decisions.                      | Model-assisted reasoning                    |
| [DebugSherlock](skills/debugsherlock/SKILL.md)   | Find the root cause of a failure through a small, evidence-led investigation.                                   | Model-assisted reasoning; shell/tool access |
| [Graphify](skills/graphify/SKILL.md)             | Map a repository’s structure, entry points, imports, and references using bounded local inspection.             | Model-assisted reasoning; shell/tool access |
| [PromptForge](skills/promptforge/SKILL.md)       | Turn an unclear development request into a concise, actionable engineering specification.                       | Model-assisted reasoning                    |
| [PromptLoop](skills/promptloop/SKILL.md)         | Run bounded implementation and verification cycles with explicit stop conditions.                               | Model-assisted reasoning; shell/tool access |
| [SecureShip](skills/secureship/SKILL.md)         | Review code changes for concrete security risks and actionable remediation.                                     | Model-assisted reasoning; shell/tool access |
| [ShipNotes](skills/shipnotes/SKILL.md)           | Write accurate development handoffs and release notes from changes and verification evidence.                   | Model-assisted reasoning; shell/tool access |
| [SkillForge](skills/skillforge/SKILL.md)         | Create and validate portable declarative skills with explicit metadata and safety boundaries.                   | Model-assisted reasoning; shell/tool access |
| [SmartDiff](skills/smartdiff/SKILL.md)           | Keep changes narrow, consistent with the codebase, and easy for a reviewer to assess.                           | Model-assisted reasoning; shell/tool access |
| [TokenSaver](skills/tokensaver/SKILL.md)         | Compress project context while preserving decisions, constraints, and evidence needed to continue work.         | Model-assisted reasoning                    |
| [UIUX Architect](skills/uiux-architect/SKILL.md) | Improve interface usability, accessibility, and design consistency within the project’s existing visual system. | Model-assisted reasoning; shell/tool access |
| [VerifyLoop](skills/verifyloop/SKILL.md)         | Check requested behavior with relevant tests and report results accurately.                                     | Model-assisted reasoning; shell/tool access |

Use `agentforge skill list`, `agentforge skill inspect <id>` and `agentforge skill validate`. Project skill roots default to `.agentforge/skills`. Identifiers must be unique across bundled and local definitions. `enabledSkills` labels activation in status reports; it never auto-runs instructions.

See the [authoring guide](docs/skills/authoring-guide.md), [format](docs/skills/skill-format.md) and [testing guide](docs/skills/testing.md). Structural validation proves schema compliance, not model performance.

The `task` runtime can send a refined brief and an explicitly opted-in current checkpoint through the selected optional provider. It offers separately approved file search/read, read-only Git inspection, edit previews and configured verification tools. Optional [built-in orchestration](docs/features/orchestration.md) implements bounded planner/executor conversations with at most two workers and centralized exact approval. It does not automatically execute these 13 skill instructions or launch external coding-host agents. The local graph remains a heuristic map; exact tokenizers and conflict-safe file application remain outside the current backend. See [task behavior](docs/features/task-runtime.md), [Git policy](docs/integrations/git-inspection.md) and [edit policy](docs/integrations/project-edits.md).

Skill metadata is read as bounded, strict UTF-8 from a single-link regular file. Traversal, unsafe links, incomplete or changing reads fail validation; parsing never executes skill instructions. These checks preserve portability without tying any skill to a vendor. All 13 definitions remain included in the packed CLI and are validated by `npm run validate:skills`; see [skill validation](docs/skills/validation.md).
