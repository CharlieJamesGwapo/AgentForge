import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { readJson, writeJson } from './storage.js';
import { AgentForgeError } from '../shared/errors.js';
import { isMissing, redactValue, safePath } from '../shared/safety.js';

const text = z.string().max(100000);
export const checkpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]{1,100}$/),
  name: z.string().min(1).max(120),
  createdAt: z.iso.datetime(),
  objective: text,
  summary: text,
  decisions: z.array(text).max(100),
  nextSteps: z.array(text).max(100),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;
type CheckpointInput = Pick<
  Checkpoint,
  'name' | 'objective' | 'summary' | 'decisions' | 'nextSteps'
>;
function parseCheckpoint(data: unknown): Checkpoint {
  const result = checkpointSchema.safeParse(data);
  if (!result.success)
    throw new AgentForgeError(
      'Invalid checkpoint metadata. Inspect or remove the corrupted checkpoint manually.',
    );
  return result.data;
}
export async function saveCheckpoint(
  root: string,
  input: CheckpointInput,
): Promise<Checkpoint> {
  const config = await loadConfig(root);
  const checkpoint = parseCheckpoint({
    ...input,
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  const safe = parseCheckpoint(redactValue(checkpoint));
  await writeJson(
    root,
    `${config.checkpointDirectory}/${safe.id}.json`,
    safe,
    false,
  );
  return safe;
}
export async function inspectCheckpoint(
  root: string,
  id: string,
): Promise<Checkpoint> {
  if (!/^[a-z0-9-]{1,100}$/.test(id))
    throw new AgentForgeError('Invalid checkpoint id.', 6);
  const config = await loadConfig(root);
  const content = await readJson(
    root,
    `${config.checkpointDirectory}/${id}.json`,
  );
  if (content === undefined)
    throw new AgentForgeError('Checkpoint not found. Use context list.');
  const checkpoint = parseCheckpoint(content);
  if (checkpoint.id !== id)
    throw new AgentForgeError('Checkpoint filename and id do not match.');
  return checkpoint;
}
export async function listCheckpoints(root: string): Promise<Checkpoint[]> {
  const config = await loadConfig(root);
  const directory = await safePath(root, config.checkpointDirectory);
  let files;
  try {
    files = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (files.length > 1000)
    throw new AgentForgeError(
      'Too many checkpoints. Archive older local data manually.',
    );
  const checkpoints: Checkpoint[] = [];
  for (const entry of files.filter((f) => f.name.endsWith('.json'))) {
    if (!entry.isFile())
      throw new AgentForgeError('Checkpoint entries must be regular files.', 6);
    checkpoints.push(await inspectCheckpoint(root, entry.name.slice(0, -5)));
  }
  return checkpoints.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function restoreCheckpoint(
  root: string,
  id: string,
  apply: boolean,
): Promise<{ applied: boolean; effects: string[]; checkpoint: Checkpoint }> {
  const checkpoint = parseCheckpoint(
    redactValue(await inspectCheckpoint(root, id)),
  );
  if (apply) await writeJson(root, '.agentforge/context.json', checkpoint);
  return {
    applied: apply,
    effects: [
      'Replace .agentforge/context.json with this checkpoint. Project source and configuration are unaffected.',
    ],
    checkpoint,
  };
}

export async function loadCurrentContext(
  root: string,
): Promise<Checkpoint | null> {
  await loadConfig(root);
  const data = await readJson(root, '.agentforge/context.json');
  return data === undefined ? null : parseCheckpoint(data);
}
