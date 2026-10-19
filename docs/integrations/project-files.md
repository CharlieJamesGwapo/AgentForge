# Approved project file tools

`project_search` and `project_read` are fixed host functions offered through `task` and `tools run`. Each batch requires explicit exact approval, including read-only requests. Model output, tool descriptions and file contents cannot approve anything. `tools list` displays the declarations offline; it does not scan source files.

## Search and list

All four arguments are required:

```json
{ "query": "parser", "mode": "path", "directory": "src", "maxResults": 20 }
```

`mode: "path"` matches literal case-sensitive text anywhere in project-relative filenames. An empty query lists allowed files under the selected directory. `mode: "content"` searches UTF-8 lines with a nonempty literal query and returns one match per matching line. Regex, globs and shell syntax have no special meaning. `directory: "."` selects the project root. `maxResults` is an integer 1–100; queries are at most 200 UTF-8 bytes with no control characters.

Results contain `matches`, `truncated`, `scannedFiles` and `skippedFiles`. Each match has a relative `path`, a one-based `line` and `text`; path-mode results use null for line/text. Text previews are at most 1024 UTF-8 bytes. `truncated` means limits or unsuitable/unreadable content prevented complete coverage, or text was clipped. A zero-match truncated result is not proof that the project contains no match. Path mode lists names without reading content, so it may list an otherwise unreadable, binary or hard-linked file that content mode would skip.

## Read a line window

All three arguments are required:

```json
{ "path": "src/parser.ts", "startLine": 1, "lineCount": 80 }
```

`startLine` is 1–1000000; `lineCount` is 1–200. Results contain `path`, `startLine`, `lines` and `truncated`. Each returned line has its one-based `number`, `text` and per-line `truncated` flag. CRLF line endings are normalized; a trailing newline does not add a phantom line. Empty files or a start beyond EOF return no lines. The top-level flag is true if more lines follow the window or text/result budgets clipped content. An individual line is at most 4096 UTF-8 bytes. Oversized, inaccessible or unsuitable files return a generic tool error without raw contents or filesystem diagnostics.

## Workspace and sharing policy

Only safe relative paths are accepted. Absolute paths, traversal, Windows drive/alternate-stream syntax, backslashes, empty path segments and controls are rejected. All path components must stay in the project; symlinks and special files are unavailable. File contents and `.gitignore` policy files require regular files with one hard link; source reads also check identity and strict UTF-8. Binary controls and invalid UTF-8 are not silently replaced.

Layered `.gitignore` rules apply to search and direct reads, including directory exclusions and negation. An ignored parent directory cannot be traversed to reinclude its children. Ignore files that are symbolic links, hard links, malformed or otherwise cannot safely be loaded cause a policy error. Static exclusions take precedence over negation:

- Directories: `.git`, `node_modules`, `dist`, `build`, `coverage`, `.agentforge`, `work`, `outputs`, `.ssh`, `.aws`, `.gnupg`.
- Credential-like files: `.env`, `.env.*`, `.npmrc`, `.netrc`, `credentials`, `credentials.json`, `id_rsa`, `id_ed25519`, and suffixes `.pem`, `.key`, `.p12`, `.pfx`, `.keystore`.

Static name matching is case-insensitive. This is a conservative exclusion list, not an assurance that all other files are safe to share. Approval displays scope/query/path/range, fixed limits and sharing disclosure. Approved returned data is redacted and schema-validated, then sent to the selected provider. Source instructions remain untrusted data. Nothing is automatically edited, imported or executed from file content.

Each invocation allows at most 256 KiB per file, 8 MiB total read bytes (including ignore metadata), 64 KiB per ignore file, 2000 scanned files, 2000 directories, depth 40, 10000 entries per directory and 100000 total directory entries. Results are at most 48 KiB of JSON before the existing redaction/result limits. Paths are at most 4096 UTF-8 bytes and 40 segments. Cancellation is checked throughout; approved execution also uses the existing tool deadline. Limits are fixed host policy, not model-controlled overrides.

Approval binds the action and scope rather than a frozen byte snapshot. Files and ignore rules can change while approval waits. The engine rechecks the live filesystem at execution, but concurrent hostile directory replacement is not fully isolated. Use a trusted root and OS isolation when needed. Redaction is best effort; do not store real secrets in shareable files.
