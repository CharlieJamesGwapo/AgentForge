# AgentFlow

The bundled AgentFlow skill describes one orchestrator, bounded tasks, at most two concurrent subagents by default, non-overlapping file ownership, explicit artifacts/acceptance, dependency tracking and central integration review. These are portable procedures for a host with real agent tools.

AgentForge provides an optional built-in planner/executor conversation scheduler through `orchestrate`. It uses explicitly configured providers/models, strict plans/results, scoped tools, inherited permissions and centralized exact approval. It defaults disabled and permits at most two workers. See [runtime setup, limits and known gaps](orchestration.md). It does not install or launch external coding-host agents. `run` remains a separate local verification loop.
