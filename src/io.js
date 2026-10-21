import { open } from 'node:fs/promises';

export async function readBounded(path, limit) {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Expected a regular file.');
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > limit) throw new Error('File exceeds the configured byte limit.');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used)); }
    catch { throw new Error('File must contain valid UTF-8.'); }
  } finally { await file.close(); }
}

export async function readJson(path, limit) {
  const text = await readBounded(path, limit);
  try { return JSON.parse(text); } catch { throw new Error('File must contain valid JSON.'); }
}
