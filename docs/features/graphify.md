# Graphify

`graph` scans an existing project, respects `.gitignore` layers, skips symlinks and common dependency/generated/private directories, and returns relative file names with local static JS/TS import edges. The scanner limits files and reads; its report states truncation and analysis limitations.

Resolution covers relative paths and common source/index extensions, including emitted `.js` imports resolving to TypeScript. It does not implement package alias resolution, dynamic runtime imports, Python graphs or compiler-level semantics. No source text is returned. Re-run after edits; there is no persistent cache to become stale. The portable Graphify skill guides deeper dependency analysis when a capable host is available.
