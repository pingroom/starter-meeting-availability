import { readBounded } from './io.js';
import { mkdir, chmod, open, stat, readdir, rename, rm, link } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

async function syncDirectory(path) {
  let handle;
  try { handle = await open(path, 'r'); await handle.sync(); }
  catch (error) { if (!['EISDIR', 'EINVAL', 'EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await syncDirectory(dirname(path));
}

export async function openState(directory, key) {
  await privateDirectory(directory);
  const lockPath = join(directory, '.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new Error('State directory is locked; see README for crash recovery.'); }
  try { await lock.writeFile(String(process.pid)); }
  catch (error) { await lock.close(); await rm(lockPath, { force: true }); throw error; }
  const path = join(directory, `${key}.json`);
  const temporary = join(directory, '.state.tmp');
  return {
    path,
    async read() {
      try {
        const value = JSON.parse(await readBounded(path, 65_536));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('State must be an object.');
        return value;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('Invalid state file. Restore a valid backup before continuing.');
      }
    },
    async write(value) {
      try { await stat(path); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if ((await readdir(directory)).filter((name) => name.endsWith('.json')).length >= 100) throw new Error('State limit reached (100 meetings). Archive completed state and receipts together, preserving replay history.');
      }
      const bytes = `${JSON.stringify(value, null, 2)}\n`;
      if (Buffer.byteLength(bytes) > 65_536) throw new Error('State exceeds 64 KiB.');
      const file = await open(temporary, 'w', 0o600);
      try { await file.chmod(0o600); await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
      await syncDirectory(directory);
    },
    async close() { await lock.close(); await rm(temporary, { force: true }); await rm(lockPath, { force: true }); },
  };
}

export async function publishReceipt(directory, filename, value) {
  await privateDirectory(directory);
  const path = join(directory, filename);
  const temporary = join(directory, `.receipt-${randomUUID()}.tmp`);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes); await file.sync(); await file.close();
    try { await link(temporary, path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await readBounded(path, 65_536) !== bytes) throw new Error('Receipt already exists with different contents; it was not overwritten.');
    }
    await syncDirectory(directory);
    return path;
  } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
}
