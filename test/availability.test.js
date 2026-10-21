import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PingRoom } from '@pingroom/sdk';
import { coordinateAvailability } from '../src/availability.js';
import { validateMeeting, TTL, hash, requestFor, assertQuestion } from '../src/model.js';
import { offline, answerQuestion, questionFor, TOKEN, ROOM, ROBOT, PEOPLE, NOW, meeting, room } from '../src/offline.js';
import { makeClient } from '../src/client.js';
import { connect } from '../src/connect.js';
import { root, loadConfig, loadConnection } from '../src/config.js';
import { openState } from '../src/storage.js';
import { readBounded, readJson } from '../src/io.js';

async function fixture(t, options = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'availability-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const transport = offline(options);
  const input = { client: transport.client, token: TOKEN, room: ROOM, meeting: structuredClone(meeting),
    directory: join(temporary, 'state'), receiptDirectory: join(temporary, 'receipts'), now: () => NOW, mode: 'send' };
  return { ...transport, input, temporary, path: join(input.directory, `${meeting.meetingId}.json`) };
}
const posts = (f) => f.calls.filter((c) => c.method === 'POST');

test('two independent direct answers produce common B and a stable receipt; rereads create no duplicates', async (t) => {
  const f = await fixture(t);
  const first = await coordinateAvailability(f.input);
  assert.equal(first.status, 'complete'); assert.deepEqual(first.commonSlots.map((s) => s.id), ['b']);
  assert.deepEqual(posts(f).map((p) => p.body.target_user_id), PEOPLE);
  assert.ok(posts(f).every((p) => p.body.responder_scope === 'direct' && p.body.ttl === TTL && p.idempotencyKey === p.body.correlation_id));
  const receipt = await readFile(first.receiptPath, 'utf8');
  const again = await coordinateAvailability(f.input);
  assert.equal(posts(f).length, 2);
  assert.equal(await readFile(again.receiptPath, 'utf8'), receipt);
  assert.equal(JSON.parse(receipt).bookingCreated, false);
});

for (const [name, choices, expected] of [
  ['both slots', ['both', 'both'], ['a', 'b']], ['neither', ['both', 'neither'], []], ['no overlap', ['a', 'b'], []],
]) {
  test(`${name} is computed as an intersection of every participant answer`, async (t) => {
    const f = await fixture(t, { choices: Object.fromEntries(PEOPLE.map((id, i) => [id, choices[i]])) });
    const result = await coordinateAvailability(f.input);
    assert.equal(result.status, 'complete'); assert.deepEqual(result.commonSlots.map((s) => s.id), expected);
  });
}

test('five participants each get a separately targeted question', async (t) => {
  const people = [...PEOPLE, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
  const f = await fixture(t, { choices: Object.fromEntries(people.map((id) => [id, 'both'])),
    onRooms: () => Response.json([{ ...room, members: people.map((id) => ({ user_id: id })) }]) });
  f.input.meeting.participants = people.map((id, i) => ({ id, label: `Person ${i + 1}` }));
  const result = await coordinateAvailability(f.input);
  assert.equal(result.status, 'complete'); assert.equal(posts(f).length, 5);
});

test('missing answer stays incomplete and is never interpreted as Neither', async (t) => {
  const f = await fixture(t, { choices: { [PEOPLE[0]]: 'both' } });
  const result = await coordinateAvailability(f.input);
  assert.equal(result.status, 'incomplete'); assert.equal(result.commonSlots, null);
  assert.equal(result.participants[1].status, 'pending');
});

test('check performs no creation and reports unasked participants', async (t) => {
  const f = await fixture(t);
  const result = await coordinateAvailability({ ...f.input, mode: 'check' });
  assert.equal(posts(f).length, 0); assert.equal(result.status, 'incomplete');
  assert.ok(result.participants.every((p) => p.status === 'unasked'));
});

test('exact request and fixed TTL are durably saved before the first creation POST', async (t) => {
  let path;
  const f = await fixture(t, { async onAsk(q, call) {
    const state = JSON.parse(await readFile(path, 'utf8'));
    const e = state.entries.find((entry) => entry.participantId === call.body.target_user_id);
    assert.equal(e.phase, 'sending'); assert.equal(e.request.ttl, 900);
    assert.equal(e.request.idempotencyKey, call.idempotencyKey);
    assert.equal(e.request.prompt, call.body.prompt);
    assert.equal(JSON.stringify(state).includes(TOKEN), false);
    return Response.json(q, { status: 201 });
  } });
  path = f.path;
  assert.equal((await coordinateAvailability(f.input)).status, 'complete');
});

test('lost creation response blocks all later sends, recovery verifies existing ID, then resumes without duplicates', async (t) => {
  let failed = false;
  const f = await fixture(t, { onAsk(q) { if (!failed) { failed = true; throw new Error('lost'); } return Response.json(q, { status: 201 }); } });
  const unknown = await coordinateAvailability(f.input);
  assert.equal(unknown.participants[0].status, 'create_unknown'); assert.equal(posts(f).length, 1);
  await coordinateAvailability(f.input); assert.equal(posts(f).length, 1);
  const id = [...f.questions.keys()][0];
  const recovered = await coordinateAvailability({ ...f.input, mode: 'recover', attach: { participantId: PEOPLE[0], questionId: id } });
  assert.equal(recovered.status, 'incomplete'); assert.equal(posts(f).length, 1);
  assert.equal((await coordinateAvailability(f.input)).status, 'complete'); assert.equal(posts(f).length, 2);
});

test('invalid creation response preserves candidate ID but requires explicit verified recovery', async (t) => {
  const f = await fixture(t, { onAsk(q) { return Response.json({ ...q, prompt: 'Unrelated question' }, { status: 201 }); } });
  const result = await coordinateAvailability(f.input);
  const id = [...f.questions.keys()][0];
  assert.equal(result.participants[0].candidateId, id);
  assert.equal(result.participants[0].status, 'create_unknown');
  const recovered = await coordinateAvailability({ ...f.input, mode: 'recover', attach: { participantId: PEOPLE[0], questionId: id } });
  assert.equal(recovered.participants[0].status, 'answered'); assert.equal(posts(f).length, 1);
});

test('wrong-target recovery cannot attach a different participant Question', async (t) => {
  const f = await fixture(t, { onAsk() { throw new Error('lost'); } });
  await coordinateAvailability(f.input);
  const [id, q] = [...f.questions][0]; q.target_user_id = PEOPLE[1];
  await assert.rejects(coordinateAvailability({ ...f.input, mode: 'recover', attach: { participantId: PEOPLE[0], questionId: id } }), { code: 'question_mismatch' });
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).entries[0].phase, 'sending');
});

test('read failure after a completed run never returns the old complete result', async (t) => {
  let unavailable = false;
  const f = await fixture(t, { onGet(q) { return unavailable ? Response.json({ error: 'private detail' }, { status: 404 }) : Response.json(answerQuestion(q, 'both')); } });
  const result = await coordinateAvailability(f.input);
  const receipt = await readFile(result.receiptPath, 'utf8'); unavailable = true;
  await assert.rejects(coordinateAvailability({ ...f.input, mode: 'check' }), { code: 'read_failed' });
  assert.equal(await readFile(result.receiptPath, 'utf8'), receipt); assert.equal(posts(f).length, 2);
});

test('changed historical answer is refused; display-name changes are harmless', async (t) => {
  let changed = false, renamed = false;
  const f = await fixture(t, { onGet(q) {
    const answer = answerQuestion(q, changed ? 'neither' : 'both');
    if (renamed) answer.answer.responder.display_name = 'New name';
    return Response.json(answer);
  } });
  await coordinateAvailability(f.input); renamed = true;
  assert.equal((await coordinateAvailability({ ...f.input, mode: 'check' })).status, 'complete');
  changed = true;
  await assert.rejects(coordinateAvailability({ ...f.input, mode: 'check' }), { code: 'question_mismatch' });
});

for (const status of ['expired', 'cancelled']) {
  test(`${status} participant leaves availability incomplete`, async (t) => {
    let closed = false;
    const f = await fixture(t, { choices: {}, onGet(q) {
      return Response.json(closed ? { ...q, state: status, resolved_at: status === 'expired' ? q.expires_at : '2026-10-21T05:01:00+00:00' } : q);
    } });
    await coordinateAvailability(f.input); closed = true;
    const result = await coordinateAvailability({ ...f.input, mode: 'check', now: () => NOW + 900_000 });
    assert.equal(result.status, 'incomplete'); assert.equal(result.commonSlots, null);
    assert.ok(result.participants.every((p) => p.status === status));
  });
}

test('past slots never remain current suggestions and late starts do not send questions', async (t) => {
  const f = await fixture(t);
  await coordinateAvailability(f.input);
  const result = await coordinateAvailability({ ...f.input, mode: 'check', now: () => Date.parse(meeting.slots[0].start) });
  assert.equal(result.status, 'stale'); assert.equal(result.commonSlots, null); assert.equal(posts(f).length, 2);
  const g = await fixture(t);
  const late = await coordinateAvailability({ ...g.input, now: () => Date.parse(meeting.slots[0].start) - 960_000 });
  assert.equal(late.status, 'incomplete'); assert.equal(posts(g).length, 0);
});

const mutations = {
  room: (q) => { q.room.code = 'WRONG1234567'; },
  target: (q) => { q.target_user_id = PEOPLE[1]; },
  prompt: (q) => { q.prompt += '!'; },
  context: (q) => { q.context = 'Wrong context'; },
  correlation: (q) => { q.correlation_id = 'different'; },
  data: (q) => { q.data.meeting_sha256 = '0'.repeat(64); },
  policy: (q) => { q.resolution_policy = 'all'; },
  scope: (q) => { q.responder_scope = 'room'; },
  handoff: (q) => { q.is_handoff = true; },
  options: (q) => { q.options[0].label = 'Different'; },
  expiry: (q) => { q.expires_at = '2026-10-21T05:20:00Z'; },
  responder: (q) => { q.answer.responder.id = PEOPLE[1]; },
  redaction: (q) => { q.answer.responder.id = null; },
  answer: (q) => { q.answer.value = 'unknown'; },
  answeredAt: (q) => { q.answer.answered_at = '2026-10-21T05:15:00+00:00'; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`rejects ${name} mismatch and never asks the next participant`, async (t) => {
    const f = await fixture(t, { onGet(q) { const answered = answerQuestion(q, 'both'); mutate(answered); return Response.json(answered); } });
    await assert.rejects(coordinateAvailability(f.input), { code: 'question_mismatch' });
    assert.equal(posts(f).length, 1);
  });
}

test('a second asking-registration identity is not accepted into the same meeting', async (t) => {
  const f = await fixture(t, { onAsk(q) { if (q.target_user_id === PEOPLE[1]) q.asker.id = PEOPLE[0]; return Response.json(q, { status: 201 }); } });
  const result = await coordinateAvailability(f.input);
  assert.equal(result.status, 'incomplete'); assert.equal(result.participants[1].status, 'create_unknown');
});

for (const [name, source] of Object.entries({
  public: [{ ...room, is_public: true }], missingPerson: [{ ...room, members: [room.members[0]] }], missingRoom: [], duplicateRoom: [room, room],
})) {
  test(`${name} room inventory blocks creation`, async (t) => {
    const f = await fixture(t, { onRooms: () => Response.json(source) });
    await assert.rejects(coordinateAvailability(f.input), { code: 'room_unavailable' }); assert.equal(posts(f).length, 0);
  });
}

test('changing meeting, participant order, or token refuses an existing journal', async (t) => {
  const f = await fixture(t);
  await coordinateAvailability({ ...f.input, mode: 'check' });
  for (const override of [ { token: 'different-token' }, { meeting: { ...meeting, title: 'Another title' } },
    { meeting: { ...meeting, participants: [...meeting.participants].reverse() } } ]) {
    await assert.rejects(coordinateAvailability({ ...f.input, ...override }), { code: 'invalid_state' });
  }
  assert.equal(posts(f).length, 0);
});

test('malformed state fails closed and state binding contains no raw credential', async (t) => {
  const f = await fixture(t);
  await coordinateAvailability({ ...f.input, mode: 'check' });
  const bytes = await readFile(f.path, 'utf8'); assert.equal(bytes.includes(TOKEN), false);
  const state = JSON.parse(bytes); state.entries[0].phase = 'asked'; await writeFile(f.path, JSON.stringify(state));
  await assert.rejects(coordinateAvailability(f.input), { code: 'invalid_state' }); assert.equal(posts(f).length, 0);
});

test('corrupt terminal state cannot fabricate a complete result', async (t) => {
  const f = await fixture(t);
  await coordinateAvailability(f.input);
  const state = JSON.parse(await readFile(f.path, 'utf8')); state.entries[0].observation.answer.responderId = PEOPLE[1];
  await writeFile(f.path, JSON.stringify(state));
  await assert.rejects(coordinateAvailability(f.input), { code: 'invalid_state' }); assert.equal(posts(f).length, 2);
});

test('concurrent execution is excluded and private permissions protect state and receipt', async (t) => {
  const f = await fixture(t);
  const store = await openState(f.input.directory, 'held');
  try { await assert.rejects(coordinateAvailability(f.input), /locked/); }
  finally { await store.close(); }
  const result = await coordinateAvailability(f.input);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
    assert.equal((await stat(f.input.directory)).mode & 0o777, 0o700);
  }
});

test('conflicting receipt is preserved and missing receipt can be recreated without new questions', async (t) => {
  const f = await fixture(t);
  await mkdir(f.input.receiptDirectory); const path = join(f.input.receiptDirectory, `${meeting.meetingId}.json`);
  await writeFile(path, '{"unrelated":true}\n');
  await assert.rejects(coordinateAvailability(f.input), /not overwritten/);
  assert.equal(await readFile(path, 'utf8'), '{"unrelated":true}\n'); await rm(path);
  assert.equal((await coordinateAvailability({ ...f.input, mode: 'check' })).status, 'complete'); assert.equal(posts(f).length, 2);
});

test('meeting validation rejects duplicated participants, overlap, invalid dates, and extra fields', () => {
  assert.throws(() => validateMeeting({ ...meeting, participants: [meeting.participants[0], meeting.participants[0]] }));
  assert.throws(() => validateMeeting({ ...meeting, slots: [meeting.slots[0], { ...meeting.slots[0], id: 'b' }] }));
  assert.throws(() => validateMeeting({ ...meeting, slots: [{ ...meeting.slots[0], start: '2026-02-30T09:00:00Z' }, meeting.slots[1]] }));
  assert.throws(() => validateMeeting({ ...meeting, execute: 'command' }));
  assert.throws(() => validateMeeting({ ...meeting, title: ' Trimmed? ' }));
});

test('bounded file reads reject oversized bytes, invalid UTF-8, and malformed JSON without leaking content', async (t) => {
  const f = await fixture(t); const path = join(f.temporary, 'input');
  await writeFile(path, 'x'.repeat(101)); await assert.rejects(readBounded(path, 100), /byte limit/);
  await writeFile(path, Buffer.from([0xc3, 0x28])); await assert.rejects(readBounded(path, 100), /UTF-8/);
  await writeFile(path, '{"secret":"never-print-this"');
  await assert.rejects(readJson(path, 100), (error) => error.message === 'File must contain valid JSON.');
});

test('environment connection requires a full pair and paths are rooted at the project', async (t) => {
  const f = await fixture(t); const path = join(f.temporary, 'meeting.json');
  await writeFile(path, JSON.stringify(meeting));
  const config = await loadConfig({ PINGROOM_TOKEN: TOKEN, PINGROOM_ROOM: ROOM.toLowerCase(), MEETING_FILE: path, STATE_DIR: 'private-state' });
  assert.equal(config.room, ROOM); assert.equal(config.directory, resolve(root, 'private-state'));
  await assert.rejects(loadConnection({ PINGROOM_TOKEN: TOKEN }, f.temporary), /both/);
});

test('aborted invocation performs no API calls or sends', async (t) => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort(new Error('stopped'));
  await assert.rejects(coordinateAvailability({ ...f.input, signal: controller.signal }), /stopped/); assert.equal(f.calls.length, 0);
});

test('production transport refuses redirects, endpoints outside its allowlist, and oversized bodies', async () => {
  const redirect = makeClient({ token: TOKEN, fetchImpl: async (_url, init) => { assert.equal(init.redirect, 'manual'); return new Response(null, { status: 302 }); } });
  await assert.rejects(redirect.rooms.list());
  const limited = makeClient({ token: TOKEN, fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) });
  await assert.rejects(limited.rooms.list());
  let called = false; const denied = makeClient({ token: TOKEN, fetchImpl: async () => { called = true; return Response.json({}); } });
  await assert.rejects(denied.broadcast(ROOM, { message: 'not allowed' })); assert.equal(called, false);
});

for (const endless of [false, true]) {
  test(`production deadline covers ${endless ? 'endless ready empty chunks' : 'a stalled body'}`, async () => {
    let cancelled = false;
    const client = makeClient({ token: TOKEN, deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { if (endless) controller.enqueue(new Uint8Array()); else return new Promise(() => {}); },
      cancel() { cancelled = true; },
    })) });
    await assert.rejects(client.rooms.list()); assert.equal(cancelled, true);
  });
}

test('transport refuses malformed UTF-8 and aborts even if a mock ignores the signal', async () => {
  const bad = makeClient({ token: TOKEN, fetchImpl: async () => new Response(Buffer.from([0xc3, 0x28])) });
  await assert.rejects(bad.rooms.list());
  const controller = new AbortController();
  const stalled = makeClient({ token: TOKEN, signal: controller.signal, fetchImpl: () => new Promise(() => {}) });
  const pending = stalled.rooms.list(); controller.abort(); await assert.rejects(pending);
});

test('offline demo runs without credentials and creates no project state', async () => {
  const before = await readdir(root);
  const result = spawnSync(process.execPath, [join(root, 'src/demo.js')], { cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((r) => r.commonSlots), [['b'], [], null]);
  assert.ok(rows.every((r) => r.createdQuestions === 2)); assert.deepEqual(await readdir(root), before);
});

function pairingClient({ failRoom = false } = {}) {
  const calls = []; let fail = failRoom;
  const client = new PingRoom({ baseUrl: 'https://pairing.invalid', fetch: async (url, init) => {
    const path = new URL(url).pathname; calls.push({ path, method: init.method, token: new Headers(init.headers).get('Authorization') });
    if (path === '/api/agent/auth') return Response.json({ credential: 'pending-token', credential_type: 'pending', expires_in: 900 });
    if (path === '/api/agent/auth/pair/start') return Response.json({ pair_browser_url: 'https://pingroom.io/agents/approve/example', expires_in: 900, poll_interval_ms: 1000 });
    if (path === '/api/agent/auth/pair/status') return Response.json({ status: 'active', credential: TOKEN, credential_type: 'active', expires_in: null, room: { invite_code: ROOM } });
    if (path === '/api/agent/rooms') return fail ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json([room]);
    throw new Error('Unexpected mock request.');
  } });
  return { client, calls, restore() { fail = false; } };
}

test('connection uses approved SDK token and never overwrites existing saved credentials', async (t) => {
  const f = await fixture(t); const p = pairingClient(); const directory = join(f.temporary, 'credentials');
  const value = await connect({ client: p.client, directory, showLink() {}, now: () => NOW });
  assert.deepEqual(value, { token: TOKEN, room: ROOM });
  assert.equal(p.calls.at(-1).token, `Bearer ${TOKEN}`);
  await assert.rejects(connect({ client: p.client, directory, showLink() {}, now: () => NOW }), /already exists/);
  assert.equal(p.calls.filter((c) => c.path === '/api/agent/auth').length, 1);
});

test('approved pairing survives room-read failure and resumes without registering again', async (t) => {
  const f = await fixture(t); const p = pairingClient({ failRoom: true }); const directory = join(f.temporary, 'credentials');
  await assert.rejects(connect({ client: p.client, directory, showLink() {}, now: () => NOW }));
  assert.equal(JSON.parse(await readFile(join(directory, 'pairing.json'), 'utf8')).phase, 'active');
  p.restore(); await connect({ client: p.client, directory, showLink() {}, now: () => NOW });
  assert.equal(p.calls.filter((c) => c.path === '/api/agent/auth').length, 1);
});
