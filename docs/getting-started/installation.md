# Installation

Requires Node.js 22.13+ (22.x) or 24+ and npm. From the checkout root, run `npm ci` and `npm run build`. Invoke `node dist/cli/index.js --help` or use `npm run dev -- --help` for source execution. Runtime dependencies are Commander, Zod, ignore and Ajv; TypeScript, tsx, ESLint and Prettier are development tooling.

The package is private and unpublished. To test distribution locally, run `npm pack --pack-destination work`, then `npm install --prefix work/install <absolute-tarball-path>` and execute the installed binary under that prefix. This does not publish anything. Do not run an assumed registry install command for an unrelated package with the same product name.

Build output is reproducible from the committed lockfile and ignored by Git. See [quickstart](quickstart.md).

`npm run test:packed` automates archive creation, isolated cache-based installation and compiled CLI smoke checks, including loopback provider fixtures. It removes its temporary project/install afterward. It does not publish an archive or contact a live AI provider.
