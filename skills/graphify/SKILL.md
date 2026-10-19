# Graphify

Map a repository’s structure, entry points, imports, and references using bounded local inspection.

## Purpose

Help developers understand repository structure and code relationships without requiring a language server or scanning generated, dependency, or secret files by default.

## Inputs

- **repository_path** (required): The local repository root to inspect.
- **focus** (optional): A subsystem, symbol, or question to prioritize.

## Expected outputs

- **repository_map:** A concise repository map with entry points, important directories, supported relationships, and uncertainty notes.

## Procedure

1. Confirm the repository root and inspect its top-level structure before reading source files.
2. Read ignore rules and exclude dependency, generated, build, cache, and secret-like paths by default.
3. Identify likely entry points, package boundaries, configuration, tests, and key documentation.
4. Trace imports and references with available local tools, limiting file counts and output size.
5. Cache only when the cache location and invalidation strategy are explicit; invalidate when tracked inputs change.
6. Label pattern-based or incomplete relationships as heuristic findings and explain the evidence.
7. Return the map with important paths and a short list of likely next files to inspect.

## Safety boundaries

- Do not read secret files or traverse symlinks outside the repository without explicit authorization.
- Respect ignore rules and use bounded file and output limits.
- Treat import and name matching as heuristic unless a parser establishes the relationship.
- Do not modify repository files while producing a read-only map.

## Capability requirements

- Model: required.
- Shell: required.
- Network: not required.

## Example

**Input:** Map the command-line entry point and its skill validation path.

**Expected output:** Identify the package entry, CLI command registration, validation module, and relevant tests; describe confirmed imports separately from name-based guesses.

## Acceptance criteria

- The map identifies the repository root, relevant entry points, and important directories with paths.
- Ignored, generated, dependency, and secret-like paths are excluded by default.
- Heuristic relationships and cache invalidation limits are stated clearly.

## Compatibility and scope

Format version 1; provider compatibility: any. This file is portable human-readable guidance. It does not execute code, call an AI service, or guarantee that a host exposes a capability. Use only the tools available and authorized in the current host.
