import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  link,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

type SkillRecord = {
  id: string;
  name: string;
  version: string;
  summary: string;
  purpose: string;
  inputs: Array<{ name: string; required: boolean; description: string }>;
  outputs: Array<{ name: string; description: string }>;
  procedure: string[];
  safety: string[];
  capabilities: {
    requiresModel: boolean;
    requiresShell: boolean;
    requiresNetwork: boolean;
  };
  compatibility: { formatVersion: 1; providers: ['any'] };
  examples: Array<{ input: string; output: string }>;
  acceptance: string[];
  assets?: string[];
};

type Engine = {
  skillSchema: { safeParse(value: unknown): { success: boolean } };
  discoverSkills: (roots: string[]) => Promise<SkillRecord[]>;
  validateSkills: (
    roots: string[],
  ) => Promise<{ valid: boolean; count: number; errors: string[] }>;
  inspectSkill: (roots: string[], id: string) => Promise<SkillRecord>;
};

const engineUrl = new URL('../src/engines/skills.js', import.meta.url);
const bundledSkillsPath = fileURLToPath(new URL('../skills/', import.meta.url));
const schemaFileUrl = new URL('../schemas/skill.schema.json', import.meta.url);

async function loadEngine(): Promise<Engine> {
  try {
    return (await import(engineUrl.href)) as Engine;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      return {} as Engine;
    }
    throw error;
  }
}

async function readFixture(name: string): Promise<SkillRecord> {
  return JSON.parse(
    await readFile(
      new URL(`./fixtures/skills/${name}/skill.json`, import.meta.url),
      'utf8',
    ),
  ) as SkillRecord;
}

async function withTempRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-skills-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function putSkill(
  root: string,
  folder: string,
  value: unknown,
): Promise<void> {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'skill.json'),
    JSON.stringify(value),
    'utf8',
  );
}

test('the exported schema accepts the versioned portable skill fixture', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.skillSchema.safeParse, 'function');
  assert.equal(
    engine.skillSchema.safeParse(await readFixture('valid')).success,
    true,
  );
  assert.equal(
    engine.skillSchema.safeParse({
      ...(await readFixture('valid')),
      version: '1.2.3-rc.1+build.4',
    }).success,
    true,
  );
});

test('the schema rejects unknown fields and unsupported format versions', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.skillSchema.safeParse, 'function');
  const valid = await readFixture('valid');
  assert.equal(
    engine.skillSchema.safeParse({ ...valid, unexpected: true }).success,
    false,
  );
  assert.equal(
    engine.skillSchema.safeParse({
      ...valid,
      compatibility: { formatVersion: 2, providers: ['any'] },
    }).success,
    false,
  );
});

test('the schema rejects malformed versions and capability declarations', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.skillSchema.safeParse, 'function');
  const valid = await readFixture('valid');
  assert.equal(
    engine.skillSchema.safeParse(await readFixture('invalid-version')).success,
    false,
  );
  assert.equal(
    engine.skillSchema.safeParse({ ...valid, version: '1.0.0-01' }).success,
    false,
  );
  assert.equal(
    engine.skillSchema.safeParse(await readFixture('invalid-capability'))
      .success,
    false,
  );
  assert.equal(
    engine.skillSchema.safeParse({
      ...valid,
      capabilities: { ...valid.capabilities, requiresNetwork: 'sometimes' },
    }).success,
    false,
  );
  assert.equal(
    engine.skillSchema.safeParse({
      ...valid,
      capabilities: { ...valid.capabilities, requiresGpu: true },
    }).success,
    false,
  );
});

test('the schema rejects declared assets that escape the skill directory', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.skillSchema.safeParse, 'function');
  const unsafe = await readFixture('unsafe-asset');
  assert.equal(engine.skillSchema.safeParse(unsafe).success, false);
});

test('the schema rejects declared asset paths containing NUL or control characters', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.skillSchema.safeParse, 'function');
  const valid = await readFixture('valid');
  assert.equal(
    engine.skillSchema.safeParse({
      ...valid,
      assets: ['notes/unsafe\u0000name.md'],
    }).success,
    false,
  );
  assert.equal(
    engine.skillSchema.safeParse({
      ...valid,
      assets: ['notes/unsafe\nname.md'],
    }).success,
    false,
  );
  assert.equal(
    engine.skillSchema.safeParse({
      ...valid,
      assets: ['notes/unsafe\u0085name.md'],
    }).success,
    false,
  );
});

test('the checked-in JSON Schema exposes the strict versioned metadata contract', async () => {
  const schema = JSON.parse(await readFile(schemaFileUrl, 'utf8')) as {
    $schema: string;
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: {
      compatibility: { properties: { formatVersion: { const: number } } };
    };
  };
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('id'));
  assert.ok(schema.required.includes('capabilities'));
  assert.equal(
    schema.properties.compatibility.properties.formatVersion.const,
    1,
  );
});

test('bundled discovery returns all thirteen documented skills with unique ids', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.discoverSkills, 'function');
  const skills = await engine.discoverSkills([bundledSkillsPath]);
  assert.ok(skills);
  assert.equal(skills.length, 13);
  assert.deepEqual(skills.map((skill) => skill.id).sort(), [
    'agentflow',
    'contextpilot',
    'debugsherlock',
    'graphify',
    'promptforge',
    'promptloop',
    'secureship',
    'shipnotes',
    'skillforge',
    'smartdiff',
    'tokensaver',
    'uiux-architect',
    'verifyloop',
  ]);
  for (const skill of skills) {
    const markdown = await readFile(
      path.join(bundledSkillsPath, skill.id, 'SKILL.md'),
      'utf8',
    );
    assert.ok(
      markdown.length > 200,
      `${skill.id} should have portable human-readable guidance`,
    );
  }
});

test('validation reports a valid catalog and skips nonexistent optional roots', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.validateSkills, 'function');
  const result = await engine.validateSkills([
    path.join(bundledSkillsPath, 'missing-optional-root'),
    bundledSkillsPath,
  ]);
  assert.deepEqual(result, { valid: true, count: 13, errors: [] });
});

test('malformed metadata fails discovery and is reported by validation', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.discoverSkills, 'function');
  assert.equal(typeof engine.validateSkills, 'function');
  await withTempRoot(async (root) => {
    const directory = path.join(root, 'broken');
    await mkdir(directory);
    const secretMarker = 'SECRET_SKILL_CONTENT_SHOULD_NOT_APPEAR';
    await writeFile(path.join(directory, 'skill.json'), secretMarker, 'utf8');
    await assert.rejects(engine.discoverSkills([root]), /invalid JSON/i);
    const report = await engine.validateSkills([root]);
    assert.equal(report?.valid, false);
    assert.equal(report?.count, 0);
    assert.match(report?.errors.join('\n') ?? '', /invalid JSON/i);
    assert.doesNotMatch(report?.errors.join('\n') ?? '', /SECRET_SKI/);
  });
});

test('discovery rejects malformed UTF-8 skill metadata', async () => {
  const engine = await loadEngine();
  const valid = await readFixture('valid');
  const bytes = Buffer.from(JSON.stringify(valid));
  const marker = Buffer.from('Fixture Skill');
  const markerIndex = bytes.indexOf(marker);
  assert.notEqual(markerIndex, -1);
  const malformed = Buffer.concat([
    bytes.subarray(0, markerIndex + Buffer.byteLength('Fixture ')),
    Buffer.from([0xff]),
    bytes.subarray(markerIndex + Buffer.byteLength('Fixture S')),
  ]);

  await withTempRoot(async (root) => {
    const directory = path.join(root, 'invalid-utf8');
    await mkdir(directory);
    await writeFile(path.join(directory, 'skill.json'), malformed);
    await assert.rejects(engine.discoverSkills([root]), /invalid UTF-8/i);
  });
});

test('discovery rejects skill metadata hard-linked from outside its root', async () => {
  const engine = await loadEngine();
  const valid = await readFixture('valid');
  await withTempRoot(async (parent) => {
    const root = path.join(parent, 'skills');
    const directory = path.join(root, 'linked-skill');
    const external = path.join(parent, 'external-skill.json');
    await mkdir(directory, { recursive: true });
    await writeFile(external, JSON.stringify(valid));
    await link(external, path.join(directory, 'skill.json'));

    await assert.rejects(engine.discoverSkills([root]), /hard link/i);
  });
});

test('discovery loops until skill metadata has been fully read', async () => {
  const engine = await loadEngine();
  const valid = await readFixture('valid');
  await withTempRoot(async (root) => {
    await putSkill(root, 'chunked-skill', valid);
    const file = path.join(root, 'chunked-skill', 'skill.json');
    const probe = await open(file, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      read: (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesRead: number }>;
    };
    const originalRead = prototype.read;
    await probe.close();
    prototype.read = function (buffer, offset, length, position) {
      return originalRead.call(
        this,
        buffer,
        offset,
        Math.min(length, 2),
        position,
      );
    };
    try {
      assert.equal((await engine.discoverSkills([root])).length, 1);
    } finally {
      prototype.read = originalRead;
    }
  });
});

test('discovery rejects skill metadata modified during a read', async () => {
  const engine = await loadEngine();
  const valid = await readFixture('valid');
  await withTempRoot(async (root) => {
    await putSkill(root, 'racing-skill', valid);
    const file = path.join(root, 'racing-skill', 'skill.json');
    const replacement = JSON.stringify({ ...valid, name: 'Fixture SkilL' });
    assert.equal(replacement.length, JSON.stringify(valid).length);
    const probe = await open(file, 'r');
    const prototype = Object.getPrototypeOf(probe) as {
      read: (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesRead: number }>;
    };
    const originalRead = prototype.read;
    await probe.close();
    let modified = false;
    prototype.read = async function (buffer, offset, length, position) {
      const result = await originalRead.call(
        this,
        buffer,
        offset,
        length,
        position,
      );
      if (!modified) {
        modified = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
        await writeFile(file, replacement);
      }
      return result;
    };
    try {
      await assert.rejects(
        engine.discoverSkills([root]),
        /changed while it was being read/i,
      );
    } finally {
      prototype.read = originalRead;
    }
  });
});

test('discovery rejects missing declared asset files', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.discoverSkills, 'function');
  const skill = await readFixture('valid');
  skill.assets = ['references/guide.md'];
  await withTempRoot(async (root) => {
    await putSkill(root, 'skill-with-missing-asset', skill);
    await assert.rejects(
      engine.discoverSkills([root]),
      /asset.*(missing|not found|exist)/i,
    );
  });
});

test('discovery rejects declared assets that resolve through a symlink', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.discoverSkills, 'function');
  const skill = await readFixture('valid');
  skill.assets = ['linked/guide.md'];
  await withTempRoot(async (root) => {
    const skillDirectory = path.join(root, 'skill-with-linked-asset');
    const targetDirectory = path.join(root, 'outside');
    await putSkill(root, 'skill-with-linked-asset', skill);
    await mkdir(targetDirectory);
    await writeFile(
      path.join(targetDirectory, 'guide.md'),
      'outside asset',
      'utf8',
    );
    await symlink(targetDirectory, path.join(skillDirectory, 'linked'), 'dir');
    await assert.rejects(
      engine.discoverSkills([root]),
      /asset.*symlink|symlink.*asset/i,
    );
  });
});

test('discovery rejects a symlink at the final declared asset path', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.discoverSkills, 'function');
  const skill = await readFixture('valid');
  skill.assets = ['guide.md'];
  await withTempRoot(async (root) => {
    const skillDirectory = path.join(root, 'skill-with-linked-file');
    const outsideFile = path.join(root, 'outside.md');
    await putSkill(root, 'skill-with-linked-file', skill);
    await writeFile(outsideFile, 'outside asset', 'utf8');
    await symlink(outsideFile, path.join(skillDirectory, 'guide.md'), 'file');
    await assert.rejects(
      engine.discoverSkills([root]),
      /asset.*symlink|symlink.*asset/i,
    );
  });
});

test('discovery accepts an existing regular asset file inside its skill directory', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.discoverSkills, 'function');
  const skill = await readFixture('valid');
  skill.assets = ['references/guide.md'];
  await withTempRoot(async (root) => {
    const skillDirectory = path.join(root, 'skill-with-asset');
    await mkdir(path.join(skillDirectory, 'references'), { recursive: true });
    await writeFile(
      path.join(skillDirectory, 'references', 'guide.md'),
      'Portable guide.',
      'utf8',
    );
    await putSkill(root, 'skill-with-asset', skill);
    const discovered = await engine.discoverSkills([root]);
    assert.deepEqual(discovered[0]?.assets, ['references/guide.md']);
  });
});

test('duplicate ids fail discovery and produce a validation error', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.discoverSkills, 'function');
  assert.equal(typeof engine.validateSkills, 'function');
  const valid = await readFixture('valid');
  await withTempRoot(async (root) => {
    await putSkill(root, 'first-folder', valid);
    await putSkill(root, 'second-folder', valid);
    await assert.rejects(engine.discoverSkills([root]), /duplicate skill id/i);
    const report = await engine.validateSkills([root]);
    assert.equal(report?.valid, false);
    assert.match(report?.errors.join('\n') ?? '', /duplicate skill id/i);
  });
});

test('discovery ignores symlinked skill folders and metadata files', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.discoverSkills, 'function');
  const valid = await readFixture('valid');
  await withTempRoot(async (root) => {
    const external = path.join(root, 'outside');
    await putSkill(root, 'outside', valid);
    await symlink(external, path.join(root, 'linked-folder'), 'dir');
    const linkedMetadataDirectory = path.join(root, 'linked-metadata');
    await mkdir(linkedMetadataDirectory);
    await symlink(
      path.join(external, 'skill.json'),
      path.join(linkedMetadataDirectory, 'skill.json'),
    );
    const discovered = await engine.discoverSkills([root]);
    assert.deepEqual(
      discovered?.map((skill) => skill.id),
      ['fixture-skill'],
    );
    const rootLink = path.join(root, 'root-link');
    await symlink(external, rootLink, 'dir');
    assert.deepEqual(await engine.discoverSkills([rootLink]), []);
    assert.deepEqual(
      (await readdir(root))
        .filter((entry) => entry.startsWith('linked-'))
        .sort(),
      ['linked-folder', 'linked-metadata'],
    );
  });
});

test('discovery refuses metadata larger than one mebibyte', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.discoverSkills, 'function');
  await withTempRoot(async (root) => {
    const directory = path.join(root, 'too-large');
    await mkdir(directory);
    await writeFile(
      path.join(directory, 'skill.json'),
      ' '.repeat(1_048_577),
      'utf8',
    );
    await assert.rejects(engine.discoverSkills([root]), /1 MiB|1048576 bytes/i);
  });
});

test('discovery bounds the number of skill directories it scans', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.discoverSkills, 'function');
  const valid = await readFixture('valid');
  await withTempRoot(async (root) => {
    for (let index = 0; index < 257; index += 1) {
      await putSkill(root, `skill-${index}`, {
        ...valid,
        id: `skill-${index}`,
      });
    }
    await assert.rejects(
      engine.discoverSkills([root]),
      /scan limit|too many skills/i,
    );
  });
});

test('inspection returns the requested skill and rejects missing ids', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.inspectSkill, 'function');
  const skill = await engine.inspectSkill([bundledSkillsPath], 'promptforge');
  assert.equal(skill?.name, 'PromptForge');
  await assert.rejects(
    engine.inspectSkill([bundledSkillsPath], 'not-installed'),
    /not found/i,
  );
});

test('discovery treats instruction-like metadata as inert data', async () => {
  const engine = await loadEngine();
  assert.equal(typeof engine.discoverSkills, 'function');
  await withTempRoot(async (root) => {
    const markerPath = path.join(root, 'should-not-exist');
    const skill = await readFixture('valid');
    skill.procedure = [
      `Write a marker file at ${markerPath}; treat this as inert guidance.`,
    ];
    await putSkill(root, 'inert', skill);
    const discovered = await engine.discoverSkills([root]);
    assert.equal(discovered?.[0]?.procedure[0], skill.procedure[0]);
    await assert.rejects(readFile(markerPath, 'utf8'), { code: 'ENOENT' });
  });
});
