import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import path from 'node:path';
import {
  createPackedInstallFiles,
  writePackedInstallFiles,
  type NpmLockfile,
  type PackedPackageManifest,
} from './helpers/packed-install.js';

const product = {
  name: 'agentforge-local-toolkit',
  version: '0.1.0-dev.0',
  dependencies: { ajv: '^8.20.0', zod: '^4.6.7' },
  bin: { agentforge: 'dist/cli/index.js' },
  engines: { node: '^22.13.0 || >=24.0.0' },
  license: 'MIT',
};

const sourceLock = {
  name: product.name,
  version: product.version,
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: product.name,
      version: product.version,
      dependencies: product.dependencies,
      devDependencies: { typescript: '^6.0.3' },
    },
    'node_modules/ajv': {
      version: '8.20.0',
      resolved: 'https://registry.npmjs.org/ajv/-/ajv-8.20.0.tgz',
      integrity: 'sha512-ajv-fixture',
    },
    'node_modules/zod': {
      version: '4.6.7',
      resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.7.tgz',
      integrity: 'sha512-zod-fixture',
    },
    'node_modules/typescript': {
      version: '6.0.3',
      resolved: 'https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz',
      integrity: 'sha512-typescript-fixture',
      dev: true,
    },
  },
};

test('packed installer lock pins the local archive and reuses locked dependency tarballs', () => {
  const prefix = path.join('/tmp', 'agentforge-packed-install');
  const tarballPath = path.join(
    '/tmp',
    'agentforge-packed-archive',
    'agentforge-local-toolkit-0.1.0-dev.0.tgz',
  );
  const tarball = Buffer.from('packed fixture archive');
  const { manifest, lockfile } = createPackedInstallFiles({
    prefix,
    tarballPath,
    tarball,
    packageManifest: product,
    sourceLockfile: sourceLock,
  });
  const tarballSpec =
    'file:../agentforge-packed-archive/agentforge-local-toolkit-0.1.0-dev.0.tgz';

  assert.deepEqual(manifest.dependencies, {
    'agentforge-local-toolkit': tarballSpec,
  });
  assert.deepEqual(lockfile.packages[''], {
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies,
  });
  assert.deepEqual(lockfile.packages['node_modules/agentforge-local-toolkit'], {
    version: product.version,
    resolved: tarballSpec,
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    dependencies: product.dependencies,
    bin: product.bin,
    engines: product.engines,
    license: product.license,
  });
  assert.deepEqual(
    lockfile.packages['node_modules/ajv'],
    sourceLock.packages['node_modules/ajv'],
  );
  assert.deepEqual(
    lockfile.packages['node_modules/zod'],
    sourceLock.packages['node_modules/zod'],
  );
  assert.ok(lockfile.packages['node_modules/typescript']?.dev);
  assert.equal(Object.hasOwn(lockfile.packages[''], 'devDependencies'), false);
});

test('packed installer lock refuses dependencies absent from the source lock', () => {
  assert.throws(
    () =>
      createPackedInstallFiles({
        prefix: '/tmp/agentforge-packed-install',
        tarballPath: '/tmp/archive/agentforge.tgz',
        tarball: Buffer.from('fixture'),
        packageManifest: { ...product, dependencies: { unpinned: 'latest' } },
        sourceLockfile: sourceLock,
      }),
    /do not match the repository lockfile/,
  );
});

test(
  'packed CLI smoke isolates inherited secret and database-password variables',
  { timeout: 60_000 },
  async (t) => {
    const npmExecPath = process.env.npm_execpath ?? '';
    if (npmExecPath.length === 0)
      throw new Error('Run this regression through npm test.');
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [npmExecPath, 'run', 'test:packed'],
        {
          cwd: process.cwd(),
          env: { ...process.env, SECRET: 'string', PGPASSWORD: 'project' },
          signal: t.signal,
          stdio: 'pipe',
        },
      ) as ChildProcessWithoutNullStreams;
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"liveProviderRequests": 0/);
  },
);

test(
  'locked packed install works with a cold metadata cache and makes no registry requests',
  { timeout: 30_000 },
  async (t) => {
    const npmExecPath = process.env.npm_execpath ?? '';
    if (npmExecPath.length === 0)
      throw new Error('Run this regression through npm test.');
    const scratch = await mkdtemp(
      path.join(tmpdir(), 'agentforge-packed-cache-'),
    );
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const dependencySource = path.join(scratch, 'dependency-source');
    const productSource = path.join(scratch, 'product-source');
    const dependencyArchive = path.join(scratch, 'dependency-archive');
    const productArchive = path.join(scratch, 'product-archive');
    const legacyPrefix = path.join(scratch, 'legacy-install');
    const lockedPrefix = path.join(scratch, 'locked-install');
    const cache = path.join(scratch, 'empty-cache');
    for (const directory of [
      dependencySource,
      productSource,
      dependencyArchive,
      productArchive,
      legacyPrefix,
      lockedPrefix,
      cache,
    ])
      await mkdir(directory);

    async function run(
      args: string[],
      cwd: string,
      registry: string,
    ): Promise<{ code: number | null; stdout: string; stderr: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [npmExecPath, ...args], {
          cwd,
          signal: t.signal,
          env: {
            ...process.env,
            npm_config_cache: cache,
            npm_config_registry: registry,
          },
          stdio: 'pipe',
        }) as ChildProcessWithoutNullStreams;
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      });
    }

    async function pack(directory: string, destination: string) {
      const result = await run(
        [
          'pack',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          destination,
        ],
        directory,
        'http://127.0.0.1:9/',
      );
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout)[0] as { filename: string };
    }

    const dependencyName = 'packed-install-fixture-dependency';
    const dependencyManifest = {
      name: dependencyName,
      version: '1.0.0',
      files: ['index.js'],
    };
    await writeFile(
      path.join(dependencySource, 'package.json'),
      JSON.stringify(dependencyManifest),
    );
    await writeFile(
      path.join(dependencySource, 'index.js'),
      'export default 1;\n',
    );
    const dependencyPacked = await pack(dependencySource, dependencyArchive);
    const dependencyTarball = path.join(
      dependencyArchive,
      dependencyPacked.filename,
    );

    const productManifest = {
      name: 'packed-install-fixture-product',
      version: '1.0.0',
      dependencies: { [dependencyName]: '^1.0.0' },
    };
    await writeFile(
      path.join(productSource, 'package.json'),
      JSON.stringify(productManifest),
    );
    await writeFile(
      path.join(productSource, 'index.js'),
      'export default 2;\n',
    );
    const productPacked = await pack(productSource, productArchive);
    const productTarball = path.join(productArchive, productPacked.filename);

    let registryRequests = 0;
    const registry = createServer((_request, response) => {
      registryRequests++;
      response.statusCode = 503;
      response.end('Registry is blocked by the fixture.');
    });
    await new Promise<void>((resolve) =>
      registry.listen(0, '127.0.0.1', resolve),
    );
    t.after(() => {
      registry.closeAllConnections();
      registry.close();
    });
    const address = registry.address();
    assert.ok(address && typeof address === 'object');
    const registryUrl = `http://127.0.0.1:${address.port}/`;

    await writeFile(
      path.join(legacyPrefix, 'package.json'),
      JSON.stringify({ name: 'legacy-packed-install', version: '1.0.0' }),
    );
    const legacy = await run(
      [
        'install',
        productTarball,
        '--offline',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
      ],
      legacyPrefix,
      registryUrl,
    );
    assert.notEqual(legacy.code, 0);
    assert.match(`${legacy.stdout}\n${legacy.stderr}`, /ENOTCACHED/);

    const relativeDependencyTarball = path
      .relative(lockedPrefix, dependencyTarball)
      .split(path.sep)
      .join('/');
    const dependencyIntegrity = `sha512-${createHash('sha512')
      .update(await readFile(dependencyTarball))
      .digest('base64')}`;
    const sourceLockfile: NpmLockfile = {
      name: productManifest.name,
      version: productManifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: productManifest.name,
          version: productManifest.version,
          dependencies: productManifest.dependencies,
        },
        [`node_modules/${dependencyName}`]: {
          version: dependencyManifest.version,
          resolved: `file:${relativeDependencyTarball}`,
          integrity: dependencyIntegrity,
        },
      },
    };
    await writePackedInstallFiles({
      prefix: lockedPrefix,
      tarballPath: productTarball,
      packageManifest: productManifest as PackedPackageManifest,
      sourceLockfile,
    });
    const locked = await run(
      [
        'ci',
        '--offline',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
      ],
      lockedPrefix,
      registryUrl,
    );
    assert.equal(locked.code, 0, locked.stderr);
    await access(
      path.join(lockedPrefix, 'node_modules', productManifest.name, 'index.js'),
    );
    await access(
      path.join(lockedPrefix, 'node_modules', dependencyName, 'index.js'),
    );
    assert.equal(registryRequests, 0);
  },
);
