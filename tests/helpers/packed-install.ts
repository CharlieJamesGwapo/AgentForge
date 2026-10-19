import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PackedPackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  bin?: string | Record<string, string>;
  engines?: Record<string, string>;
  license?: string;
  os?: string[];
  cpu?: string[];
}

export interface NpmLockfile {
  name?: string;
  version?: string;
  lockfileVersion: number;
  requires?: boolean;
  packages: Record<string, Record<string, unknown>>;
}

export interface PackedInstallFiles {
  manifest: {
    name: string;
    version: string;
    private: true;
    dependencies: Record<string, string>;
  };
  lockfile: NpmLockfile;
}

const INSTALLER_NAME = 'agentforge-packed-install';

function sameDependencies(
  left: Record<string, unknown>,
  right: Record<string, string>,
): boolean {
  const keys = Object.keys(right);
  return (
    Object.keys(left).length === keys.length &&
    keys.every((key) => left[key] === right[key])
  );
}

function packageLockMetadata(
  manifest: PackedPackageManifest,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'bin',
    'engines',
    'license',
    'os',
    'cpu',
  ] as const) {
    const value = manifest[key];
    if (value !== undefined) metadata[key] = value;
  }
  return metadata;
}

/** Build a complete npm-ci lock for installing the packed archive as a dependency. */
export function createPackedInstallFiles(input: {
  prefix: string;
  tarballPath: string;
  tarball: Uint8Array;
  packageManifest: PackedPackageManifest;
  sourceLockfile: NpmLockfile;
}): PackedInstallFiles {
  const { prefix, tarballPath, tarball, packageManifest, sourceLockfile } =
    input;
  const sourceRoot = sourceLockfile.packages[''];
  const sourceDependencies = (sourceRoot?.dependencies ?? {}) as Record<
    string,
    unknown
  >;
  const dependencies = packageManifest.dependencies ?? {};
  if (!sameDependencies(sourceDependencies, dependencies))
    throw new Error(
      'Packed package dependencies do not match the repository lockfile.',
    );

  const relativeTarball = path
    .relative(prefix, tarballPath)
    .split(path.sep)
    .join('/');
  const packageSpec = `file:${relativeTarball}`;
  const manifest = {
    name: INSTALLER_NAME,
    version: '1.0.0',
    private: true as const,
    dependencies: { [packageManifest.name]: packageSpec },
  };
  const installedPackagePath = `node_modules/${packageManifest.name}`;
  const packages = Object.fromEntries(
    Object.entries(sourceLockfile.packages).filter(([key]) => key !== ''),
  );
  packages[installedPackagePath] = {
    version: packageManifest.version,
    resolved: packageSpec,
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    ...packageLockMetadata(packageManifest),
  };

  return {
    manifest,
    lockfile: {
      ...sourceLockfile,
      name: manifest.name,
      version: manifest.version,
      packages: {
        '': {
          name: manifest.name,
          version: manifest.version,
          dependencies: manifest.dependencies,
        },
        ...packages,
      },
    },
  };
}

/** Write the isolated installer manifest and complete lock beside its node_modules. */
export async function writePackedInstallFiles(input: {
  prefix: string;
  tarballPath: string;
  packageManifest: PackedPackageManifest;
  sourceLockfile: NpmLockfile;
}): Promise<void> {
  const files = createPackedInstallFiles({
    ...input,
    tarball: await readFile(input.tarballPath),
  });
  await writeFile(
    path.join(input.prefix, 'package.json'),
    `${JSON.stringify(files.manifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(input.prefix, 'package-lock.json'),
    `${JSON.stringify(files.lockfile, null, 2)}\n`,
  );
}
