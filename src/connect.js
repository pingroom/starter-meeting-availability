import { readJson } from './io.js';
import { openState, publishReceipt } from './storage.js';
import { resolve } from 'node:path';
import { validateConnection } from './config.js';
import { assertRoom, roomCode, exactKeys } from './model.js';

/** Resumes a saved pairing link or active pairing response; never overwrites credentials. */
export async function connect({ client, directory, requestedRoom, signal, showLink = console.log, now = Date.now }) {
  if (requestedRoom !== undefined && !roomCode(requestedRoom)) throw new Error('Room codes contain 12 letters or digits.');
  const store = await openState(directory, 'pairing');
  try {
    try { await readJson(resolve(directory, 'credentials.json'), 32_768); throw new Error('A saved connection already exists. Use it, or archive it deliberately before reconnecting.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    signal?.throwIfAborted();
    let pending = await store.read();
    if (!pending) {
      const pairing = await client.auth.startPairing({ agent_label: 'Meeting availability' });
      pending = { version: 1, phase: 'pending', token: client.getToken(), pairing, createdAt: now(), active: null };
      await store.write(pending);
    }
    if (!exactKeys(pending, 'version,phase,token,pairing,createdAt,active') || pending.version !== 1
      || !['pending', 'active'].includes(pending.phase) || typeof pending.token !== 'string'
      || !/^[^\s\x00-\x1f\x7f]{1,8192}$/.test(pending.token) || !Number.isSafeInteger(pending.createdAt)
      || !Number.isInteger(pending.pairing?.expires_in) || pending.pairing.expires_in < 1 || pending.pairing.expires_in > 3600
      || (pending.phase === 'pending' && pending.active !== null)
      || (pending.phase === 'active' && (pending.active?.credential !== pending.token || pending.active?.credential_type !== 'active'))) throw new Error('Saved pairing is invalid. Restore a valid backup before reconnecting.');
    if (pending.phase === 'pending') {
      const remaining = Math.floor((pending.createdAt + pending.pairing.expires_in * 1000 - now()) / 1000);
      if (remaining <= 0) throw new Error('Saved pairing expired. Confirm it is no longer usable, remove only .pingroom/pairing.json, and reconnect.');
      const url = new URL(pending.pairing.pair_browser_url ?? pending.pairing.pair_url);
      if (url.origin !== 'https://pingroom.io' || url.username || url.password) throw new Error('Unexpected pairing URL.');
      showLink(`Approve this connection: ${url.href}`);
      client.setToken(pending.token);
      const active = await client.auth.waitForPairing({ ...pending.pairing, expires_in: remaining }, { signal });
      // waitForPairing has already switched the SDK to the approved token.
      pending = { ...pending, phase: 'active', active, token: active.credential };
      await store.write(pending);
    }
    signal?.throwIfAborted();
    const connection = validateConnection({ token: pending.token,
      room: requestedRoom ?? (pending.active?.home_room ?? pending.active?.room)?.invite_code });
    client.setToken(connection.token);
    assertRoom(await client.rooms.list(), connection.room);
    await publishReceipt(directory, 'credentials.json', connection);
    return connection;
  } finally { await store.close(); }
}
