import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { readBounded, readJson } from './io.js';
import { roomCode, validateMeeting } from './model.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const credentialDirectory = resolve(root, '.pingroom');
export function validateConnection(value) {
  if (typeof value?.token !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,8192}$/.test(value.token)
    || typeof value.room !== 'string' || !roomCode(value.room.toUpperCase())) throw new Error('Supply both PINGROOM_TOKEN and PINGROOM_ROOM, or run npm run connect.');
  return { token: value.token, room: value.room.toUpperCase() };
}
export async function loadEnvironment(env = process.env) {
  let source;
  try { source = await readBounded(resolve(root, '.env'), 16_384); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const [key, value] of Object.entries(parseEnv(source))) if (env[key] === undefined) env[key] = value;
}
export async function loadConnection(env = process.env, directory = credentialDirectory) {
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) return validateConnection({ token: env.PINGROOM_TOKEN, room: env.PINGROOM_ROOM });
  let saved;
  try { saved = await readJson(resolve(directory, 'credentials.json'), 32_768); }
  catch { throw new Error('No valid saved connection. Run npm run connect or supply both credential variables.'); }
  return validateConnection(saved);
}
export async function loadConfig(env = process.env) {
  let meeting;
  try { meeting = validateMeeting(await readJson(resolve(root, env.MEETING_FILE || 'meeting.local.json'), 16_384)); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Copy examples/meeting.example.json to meeting.local.json and configure future slots and participants.'); throw error; }
  return { ...await loadConnection(env), meeting,
    directory: resolve(root, env.STATE_DIR || '.meetings'), receiptDirectory: resolve(root, env.RECEIPT_DIR || 'receipts') };
}
