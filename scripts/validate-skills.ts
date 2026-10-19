import { fileURLToPath } from 'node:url';
import { validateSkills } from '../src/engines/skills.js';

const bundledSkillsRoot = fileURLToPath(new URL('../skills/', import.meta.url));
const result = await validateSkills([bundledSkillsRoot]);

if (result.valid) {
  console.log(`Validated ${result.count} bundled skills.`);
} else {
  for (const error of result.errors) console.error(error);
  process.exitCode = 1;
}
