# Quickstart

Follow [installation](installation.md) to clone the public repository, install dependencies and build. Then run these commands from the source checkout:

```sh
node dist/cli/index.js init
node dist/cli/index.js doctor
node dist/cli/index.js skill list
node dist/cli/index.js prompt --task "Fix parser with regression tests"
node dist/cli/index.js context save --name parser --objective "Fix parser" --summary "Reproduction recorded"
node dist/cli/index.js context list
node dist/cli/index.js graph
node dist/cli/index.js verify
```

`init` preserves an existing valid config. `verify` returns a plan and starts no process. Use `--cwd <directory>` to target another existing project. `--json` selects the stable machine-readable interface for reports. No credentials or external provider are needed.

Checkpoint restore previews by default. Copy the returned id into `context restore <id>`, inspect it, then use `--apply` to update active context only. See [configuration](configuration.md).
