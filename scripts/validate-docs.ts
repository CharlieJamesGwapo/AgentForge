import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const files: string[] = [];
async function walk(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error('Documentation must not use symbolic links.');
    if (
      [
        'node_modules',
        'dist',
        '.git',
        '.agentforge',
        'work',
        'outputs',
      ].includes(entry.name)
    )
      continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(filename);
    else if (entry.name.endsWith('.md')) files.push(filename);
  }
}
await walk(root);
const errors: string[] = [];
let links = 0;
for (const filename of files) {
  const content = await readFile(filename, 'utf8');
  if (!content.trim()) errors.push(`${path.relative(root, filename)} is empty`);
  for (const match of content.matchAll(
    /\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,
  )) {
    const target = match[1]!;
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const relative = decodeURIComponent(target.split('#')[0]!).replace(
      /^<|>$/g,
      '',
    );
    const resolved = path.resolve(path.dirname(filename), relative);
    if (path.relative(root, resolved).startsWith('..')) {
      errors.push(`${filename}: link escapes project`);
      continue;
    }
    links++;
    try {
      await access(resolved);
    } catch {
      errors.push(`${path.relative(root, filename)}: missing ${target}`);
    }
  }
}
console.log(
  JSON.stringify(
    { valid: errors.length === 0, files: files.length, links, errors },
    null,
    2,
  ),
);
if (errors.length) process.exitCode = 1;
