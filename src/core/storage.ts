import { mkdir, open, rename, unlink, link, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { TextDecoder } from 'node:util';
import { isMissing, safePath } from '../shared/safety.js';
import { AgentForgeError } from '../shared/errors.js';

export async function readJson(
  root: string,
  relative: string,
): Promise<unknown | undefined> {
  const filename = await safePath(root, relative);
  let handle;
  try {
    handle = await open(
      filename,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      throw new AgentForgeError(
        `Expected a single-link JSON file at most 1 MiB: ${relative}`,
      );
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > 1024 * 1024)
      throw new AgentForgeError('JSON input exceeds 1 MiB.');
    const after = await handle.stat();
    if (
      bytesRead !== stat.size ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.nlink !== 1 ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      after.mode !== stat.mode
    )
      throw new AgentForgeError('JSON input changed while it was being read.');
    let content: string;
    try {
      content = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new AgentForgeError(`Invalid UTF-8 in ${relative}.`);
    }
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new AgentForgeError(
        `Invalid JSON in ${relative}. Repair the file before continuing.`,
      );
    }
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeJson(
  root: string,
  relative: string,
  data: unknown,
  replace = true,
): Promise<void> {
  const filename = await safePath(root, relative);
  const parentRelative = path.posix.dirname(relative);
  if (parentRelative !== '.') {
    let partial = '';
    for (const segment of parentRelative.split('/')) {
      partial = partial ? `${partial}/${segment}` : segment;
      const directory = await safePath(root, partial);
      await mkdir(directory, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      if (!(await lstat(directory)).isDirectory())
        throw new AgentForgeError('Storage parent must be a directory.', 6);
    }
  }
  await safePath(root, relative);
  const serialized = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 1024 * 1024)
    throw new AgentForgeError('JSON output exceeds 1 MiB.');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  let handleOpen = true;
  let operationError: unknown;
  try {
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handleOpen = false;
    await safePath(root, relative);
    if (replace) await rename(temporary, filename);
    else {
      await link(temporary, filename);
      await unlink(temporary);
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (handleOpen) {
      await handle.close().catch((error) => {
        if (operationError === undefined) throw error;
      });
    }
    await unlink(temporary).catch((error) => {
      if (!isMissing(error) && operationError === undefined) throw error;
    });
  }
}
