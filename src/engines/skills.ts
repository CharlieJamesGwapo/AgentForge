import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

const MAX_METADATA_BYTES = 1_048_576;
const MAX_ROOTS = 64;
const MAX_ENTRIES_PER_ROOT = 4_096;
const MAX_SKILLS_PER_ROOT = 256;
const MAX_TOTAL_SKILLS = 512;

const safeRelativeAssetPath = new RegExp(
  String.raw`^(?!\/)(?![A-Za-z]:)(?!.*:)(?!.*\\)(?!.*\/\/)(?!.*\/$)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[\u0000-\u001f\u007f-\u009f])[\s\S]+$`,
  'u',
);

const inputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/u),
    required: z.boolean(),
    description: z.string().min(1).max(2_000),
  })
  .strict();

const outputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]*$/u),
    description: z.string().min(1).max(2_000),
  })
  .strict();

const exampleSchema = z
  .object({
    input: z.string().min(1).max(10_000),
    output: z.string().min(1).max(10_000),
  })
  .strict();

export const skillSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    name: z.string().min(1).max(100),
    version: z
      .string()
      .max(128)
      .regex(
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
      ),
    summary: z.string().min(1).max(500),
    purpose: z.string().min(1).max(5_000),
    inputs: z.array(inputSchema).min(1).max(32),
    outputs: z.array(outputSchema).min(1).max(32),
    procedure: z.array(z.string().min(1).max(5_000)).min(1).max(64),
    safety: z.array(z.string().min(1).max(2_000)).min(1).max(64),
    capabilities: z
      .object({
        requiresModel: z.boolean(),
        requiresShell: z.boolean(),
        requiresNetwork: z.boolean(),
      })
      .strict(),
    compatibility: z
      .object({
        formatVersion: z.literal(1),
        providers: z.tuple([z.literal('any')]),
      })
      .strict(),
    examples: z.array(exampleSchema).min(1).max(16),
    acceptance: z.array(z.string().min(1).max(2_000)).min(1).max(64),
    assets: z
      .array(z.string().max(512).regex(safeRelativeAssetPath))
      .max(64)
      .optional(),
  })
  .strict();

export type Skill = z.infer<typeof skillSchema>;

function describePath(value: string): string {
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatValidationError(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const field =
        issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>';
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

function sameMetadataIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}

async function readSkillMetadata(
  filePath: string,
  expected: Stats,
): Promise<Skill | undefined> {
  let fileHandle;
  try {
    fileHandle = await open(
      filePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return undefined;
    throw new Error(
      `Unable to open skill metadata ${describePath(filePath)}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  try {
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile() || fileStat.nlink !== 1) {
      throw new Error(
        `Skill metadata ${describePath(filePath)} must be a regular file without hard links.`,
      );
    }
    if (!sameMetadataIdentity(expected, fileStat)) {
      throw new Error(
        `Skill metadata ${describePath(filePath)} changed before it could be read.`,
      );
    }
    if (fileStat.size > MAX_METADATA_BYTES) {
      throw new Error(
        `Skill metadata ${describePath(filePath)} exceeds the 1 MiB limit (1048576 bytes).`,
      );
    }

    const boundedBuffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < boundedBuffer.length) {
      const result = await fileHandle.read(
        boundedBuffer,
        bytesRead,
        boundedBuffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_METADATA_BYTES) {
      throw new Error(
        `Skill metadata ${describePath(filePath)} exceeds the 1 MiB limit (1048576 bytes).`,
      );
    }

    const afterRead = await fileHandle.stat();
    if (
      bytesRead !== fileStat.size ||
      afterRead.nlink !== 1 ||
      !sameMetadataIdentity(fileStat, afterRead)
    ) {
      throw new Error(
        `Skill metadata ${describePath(filePath)} changed while it was being read.`,
      );
    }

    let content: string;
    try {
      content = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(boundedBuffer.subarray(0, bytesRead));
    } catch {
      throw new Error(
        `Invalid UTF-8 in skill metadata ${describePath(filePath)}.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      throw new Error(
        `Invalid JSON in skill metadata ${describePath(filePath)}.`,
      );
    }

    const result = skillSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid skill metadata ${describePath(filePath)}: ${formatValidationError(result.error.issues)}`,
      );
    }
    await validateDeclaredAssets(path.dirname(filePath), result.data);
    return result.data;
  } finally {
    await fileHandle.close();
  }
}

async function validateDeclaredAssets(
  skillDirectory: string,
  skill: Skill,
): Promise<void> {
  const absoluteSkillDirectory = path.resolve(skillDirectory);

  for (const asset of skill.assets ?? []) {
    const absoluteAssetPath = path.resolve(absoluteSkillDirectory, asset);
    const relativePath = path.relative(
      absoluteSkillDirectory,
      absoluteAssetPath,
    );
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(
        `Declared asset ${JSON.stringify(asset)} for skill ${JSON.stringify(skill.id)} escapes its skill directory.`,
      );
    }

    let currentPath = absoluteSkillDirectory;
    const components = asset.split('/');
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      if (!component) {
        throw new Error(
          `Declared asset ${JSON.stringify(asset)} for skill ${JSON.stringify(skill.id)} has an empty path component.`,
        );
      }
      currentPath = path.join(currentPath, component);

      let componentStat;
      try {
        componentStat = await lstat(currentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `Declared asset ${JSON.stringify(asset)} for skill ${JSON.stringify(skill.id)} is missing.`,
            { cause: error },
          );
        }
        throw new Error(
          `Unable to inspect declared asset ${JSON.stringify(asset)} for skill ${JSON.stringify(skill.id)}: ${errorMessage(error)}`,
          { cause: error },
        );
      }

      if (componentStat.isSymbolicLink()) {
        throw new Error(
          `Declared asset ${JSON.stringify(asset)} for skill ${JSON.stringify(skill.id)} contains a symlink.`,
        );
      }

      const isLastComponent = index === components.length - 1;
      if (
        isLastComponent ? !componentStat.isFile() : !componentStat.isDirectory()
      ) {
        throw new Error(
          `Declared asset ${JSON.stringify(asset)} for skill ${JSON.stringify(skill.id)} must resolve to a regular file through directories.`,
        );
      }
    }
  }
}

async function scanRoot(
  root: string,
  knownIds: Map<string, string>,
): Promise<Skill[]> {
  const absoluteRoot = path.resolve(root);
  let rootStat;
  try {
    rootStat = await lstat(absoluteRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `Unable to inspect skill root ${describePath(absoluteRoot)}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (rootStat.isSymbolicLink()) return [];
  if (!rootStat.isDirectory()) {
    throw new Error(
      `Skill root ${describePath(absoluteRoot)} is not a directory.`,
    );
  }

  const found: Skill[] = [];
  const directory = await opendir(absoluteRoot);
  let entriesSeen = 0;
  let skillsSeen = 0;

  for await (const entry of directory) {
    entriesSeen += 1;
    if (entriesSeen > MAX_ENTRIES_PER_ROOT) {
      throw new Error(
        `Skill scan limit exceeded for ${describePath(absoluteRoot)}: at most ${MAX_ENTRIES_PER_ROOT} directory entries.`,
      );
    }
    if (!entry.isDirectory()) continue;

    const skillFile = path.join(absoluteRoot, entry.name, 'skill.json');
    let metadataStat;
    try {
      metadataStat = await lstat(skillFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(
        `Unable to inspect skill metadata ${describePath(skillFile)}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    skillsSeen += 1;
    if (skillsSeen > MAX_SKILLS_PER_ROOT) {
      throw new Error(
        `Skill scan limit exceeded for ${describePath(absoluteRoot)}: at most ${MAX_SKILLS_PER_ROOT} skills per root.`,
      );
    }
    if (metadataStat.isSymbolicLink()) continue;
    if (!metadataStat.isFile()) {
      throw new Error(
        `Skill metadata ${describePath(skillFile)} is not a regular file.`,
      );
    }

    const skill = await readSkillMetadata(skillFile, metadataStat);
    if (!skill) continue;

    const previousPath = knownIds.get(skill.id);
    if (previousPath) {
      throw new Error(
        `Duplicate skill id ${JSON.stringify(skill.id)} found in ${describePath(previousPath)} and ${describePath(skillFile)}.`,
      );
    }
    if (knownIds.size >= MAX_TOTAL_SKILLS) {
      throw new Error(
        `Skill scan limit exceeded: at most ${MAX_TOTAL_SKILLS} skills across all roots.`,
      );
    }
    knownIds.set(skill.id, skillFile);
    found.push(skill);
  }

  return found;
}

export async function discoverSkills(roots: string[]): Promise<Skill[]> {
  if (roots.length > MAX_ROOTS) {
    throw new Error(
      `Skill scan limit exceeded: at most ${MAX_ROOTS} roots may be supplied.`,
    );
  }

  const knownIds = new Map<string, string>();
  const skills: Skill[] = [];
  for (const root of roots) {
    skills.push(...(await scanRoot(root, knownIds)));
  }
  return skills.sort((left, right) => left.id.localeCompare(right.id));
}

export async function validateSkills(
  roots: string[],
): Promise<{ valid: boolean; count: number; errors: string[] }> {
  try {
    const skills = await discoverSkills(roots);
    return { valid: true, count: skills.length, errors: [] };
  } catch (error) {
    return { valid: false, count: 0, errors: [errorMessage(error)] };
  }
}

export async function inspectSkill(
  roots: string[],
  id: string,
): Promise<Skill> {
  const skill = (await discoverSkills(roots)).find(
    (candidate) => candidate.id === id,
  );
  if (!skill) throw new Error(`Skill ${JSON.stringify(id)} was not found.`);
  return skill;
}
