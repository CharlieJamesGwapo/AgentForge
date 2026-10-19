# Installation

AgentForge source is public at [CharlieJamesGwapo/AgentForge](https://github.com/CharlieJamesGwapo/AgentForge). It is a development version, not a published npm package or versioned GitHub release. The package name is `agentforge-local-toolkit`, with version `0.1.0-dev.0`; `private: true` prevents npm publication without making the GitHub source private.

## Build from source

Use Node.js **22.13+ in the 22.x line, or 24+**, npm and Git. The following commands work in a POSIX shell or PowerShell:

```sh
git clone https://github.com/CharlieJamesGwapo/AgentForge.git
cd AgentForge
npm ci
npm run build
node dist/cli/index.js --help
node dist/cli/index.js --version
node dist/cli/index.js skill list
```

`npm ci` installs the committed lockfile and may contact the npm registry. Runtime dependencies are Commander, Zod, ignore and Ajv. No AI credentials are needed to install, build or run offline commands. Optional inference needs a configured provider, credentials where required and explicit network approval.

From the source root, use `node dist/cli/index.js <command>` after building, or `npm run dev -- <command>` during development. Building does not put `agentforge` on your global PATH. Examples using that name assume an installed CLI; substitute the built entry point when working from source. See [quickstart](quickstart.md).

## Install a local tarball

From the source root, create an archive and install it into a local prefix:

```sh
node -e "require('node:fs').mkdirSync('work/package', {recursive: true})"
npm pack --pack-destination work/package
# Use the exact archive filename printed by npm pack:
npm install --prefix work/install --ignore-scripts --omit=dev ./work/package/agentforge-local-toolkit-0.1.0-dev.0.tgz
node work/install/node_modules/agentforge-local-toolkit/dist/cli/index.js --help
node work/install/node_modules/agentforge-local-toolkit/dist/cli/index.js skill list
```

Packing builds the compiled CLI and validates bundled skills. The prefix install may fetch production dependencies from npm; it does not publish anything or call an AI provider. Run the installed entry point explicitly as above; the local prefix does not add a global command. Use `--cwd <existing-project>` to select a project. The archive excludes local state, reports, tests and dependencies. Build output, tarballs and `work/` are ignored by Git.

Do not assume `npm install -g agentforge` or `npx agentforge` refers to this project. There is no verified npm publication for AgentForge.

## Installation verification

`npm run test:packed` packs and installs the compiled CLI in a temporary prefix, then checks offline commands and loopback provider fixtures. It uses a lock-derived offline installer and requires cached dependency tarballs; cached registry metadata is not required. Temporary data is removed afterward. No live provider is contacted.

Linux Node 22/24 and macOS Node 24 passed full checks, packed installation and terminal tests at commit `86cce82`; Windows Node 24 passed type checking and packed installation. The Windows job does not run the full unit or POSIX terminal suites. See [recorded hosted CI results](../development/testing.md#verified-hosted-ci) for evidence and limitations. Git is needed for Git tools; Python 3 and POSIX pseudo-terminals are needed only for the terminal smoke suite.
