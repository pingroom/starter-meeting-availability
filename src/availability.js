import { randomUUID } from 'node:crypto';
import { openState, publishReceipt } from './storage.js';
import { TTL, SEND_MARGIN_MS, uuid, roomCode, record, exactKeys, validDate, canonical, hash, fail,
  validateMeeting, requestFor, assertRoom, assertQuestion, summarize } from './model.js';

function validateObservation(observation, entry, participant) {
  if (!exactKeys(observation, 'state,resolvedAt,answer') || !['pending', 'answered', 'expired', 'cancelled'].includes(observation.state)) fail('invalid_state', 'Invalid saved observation.');
  if (observation.state === 'pending') {
    if (observation.resolvedAt !== null || observation.answer !== null) fail('invalid_state', 'Invalid pending observation.');
  } else {
    if (!validDate(observation.resolvedAt) || Date.parse(observation.resolvedAt) < Date.parse(entry.createdAt)
      || (observation.state === 'expired' ? Date.parse(observation.resolvedAt) !== Date.parse(entry.expiresAt) : Date.parse(observation.resolvedAt) >= Date.parse(entry.expiresAt))) fail('invalid_state', 'Invalid terminal observation timestamp.');
    if (observation.state === 'answered') {
      const a = observation.answer;
      if (!exactKeys(a, 'value,responderId,answeredAt') || !['a', 'b', 'both', 'neither'].includes(a.value)
        || a.responderId !== participant.id || !validDate(a.answeredAt) || Date.parse(a.answeredAt) !== Date.parse(observation.resolvedAt)) fail('invalid_state', 'Invalid saved attributed answer.');
    } else if (observation.answer !== null) fail('invalid_state', 'Unexpected saved answer.');
  }
}

function validateState(state, binding, meeting) {
  if (!exactKeys(state, 'version,binding,askerId,entries') || state.version !== 1 || state.binding !== binding
    || (state.askerId !== null && !uuid(state.askerId)) || !Array.isArray(state.entries) || state.entries.length !== meeting.participants.length) fail('invalid_state', 'State belongs to different input or credentials, or is invalid. Restore the original meeting and a valid state backup.');
  const ids = new Set();
  for (const [i, entry] of state.entries.entries()) {
    const person = meeting.participants[i];
    if (!exactKeys(entry, 'participantId,phase,key,request,intentAt,questionId,candidateId,createdAt,expiresAt,observation')
      || entry.participantId !== person.id || !['unasked', 'sending', 'asked'].includes(entry.phase)) fail('invalid_state', 'Invalid saved participant state.');
    if (entry.phase === 'unasked') {
      if (['key', 'request', 'intentAt', 'questionId', 'candidateId', 'createdAt', 'expiresAt', 'observation'].some((k) => entry[k] !== null)) fail('invalid_state', 'Unasked participant has inconsistent state.');
      continue;
    }
    if (typeof entry.key !== 'string' || !entry.key.startsWith('availability-') || !uuid(entry.key.slice(13))
      || !validDate(entry.intentAt) || canonical(entry.request) !== canonical(requestFor(meeting, person.id, entry.key))) fail('invalid_state', 'Saved request or idempotency key is invalid.');
    if (entry.phase === 'sending') {
      if (entry.questionId !== null || entry.createdAt !== null || entry.expiresAt !== null || entry.observation !== null
        || (entry.candidateId !== null && !uuid(entry.candidateId))) fail('invalid_state', 'Invalid uncertain creation state.');
    } else {
      if (!uuid(entry.questionId) || ids.has(entry.questionId) || entry.candidateId !== null || !state.askerId
        || !validDate(entry.createdAt) || !validDate(entry.expiresAt)
        || Date.parse(entry.createdAt) < Date.parse(entry.intentAt) - 5000
        || Math.abs(Date.parse(entry.expiresAt) - Date.parse(entry.createdAt) - TTL * 1000) > 5000
        || Date.parse(entry.expiresAt) >= Date.parse(meeting.slots[0].start)) fail('invalid_state', 'Invalid saved question identity or lifetime.');
      ids.add(entry.questionId);
      validateObservation(entry.observation, entry, person);
    }
  }
}

function freshEntry(person) {
  return { participantId: person.id, phase: 'unasked', key: null, request: null, intentAt: null,
    questionId: null, candidateId: null, createdAt: null, expiresAt: null, observation: null };
}

/** One pass: send any unasked participants, or read known questions without sending. */
export async function coordinateAvailability({ client, token, room, meeting: rawMeeting, directory, receiptDirectory,
  mode = 'check', attach, now = Date.now, signal }) {
  const meeting = validateMeeting(rawMeeting);
  if (!['check', 'send', 'recover'].includes(mode) || !Number.isFinite(now())) fail('invalid_input', 'Invalid mode or clock.');
  if (typeof token !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,8192}$/.test(token) || !roomCode(room)) fail('invalid_connection', 'Provide a complete PingRoom connection.');
  if ((mode === 'recover') !== (attach !== undefined)
    || attach && (!exactKeys(attach, 'participantId,questionId') || !meeting.participants.some((p) => p.id === attach.participantId) || !uuid(attach.questionId))) fail('invalid_input', 'Recovery needs a configured participant UUID and existing Question UUID.');
  const binding = hash({ meeting, room, credentialHash: hash(token), ttl: TTL });
  const store = await openState(directory, meeting.meetingId);
  let state;
  const stopped = () => signal?.throwIfAborted();
  const verify = (q, entry, id) => {
    const observation = assertQuestion(q, entry.request, { room, questionId: id, askerId: state.askerId,
      createdAt: entry.createdAt, expiresAt: entry.expiresAt, firstSlot: meeting.slots[0].start, now: now() });
    if (Date.parse(q.created_at) < Date.parse(entry.intentAt) - 5000
      || state.entries.some((other) => other !== entry && other.questionId === q.id)) fail('question_mismatch', 'Question predates this intent or is already assigned to another participant.');
    if (entry.observation && entry.observation.state !== 'pending' && canonical(entry.observation) !== canonical(observation)) fail('question_mismatch', 'A previously terminal answer changed; no availability result was produced.');
    return observation;
  };
  const get = async (id) => {
    stopped();
    try { return await client.questions.get(id); }
    catch { fail('read_failed', 'Could not read a participant Question. Keep the journal and retry check; no shared-slot result was produced.'); }
  };
  const save = async () => { validateState(state, binding, meeting); await store.write(state); };
  const result = async () => {
    const summary = summarize(meeting, state.entries, now());
    if (summary.status === 'complete') {
      const receipt = { version: 1, meeting, meetingSha256: hash(meeting), room,
        completedAt: new Date(Math.max(...state.entries.map((e) => Date.parse(e.observation.answer.answeredAt)))).toISOString(),
        answers: state.entries.map((e) => ({ participantId: e.participantId, questionId: e.questionId, ...e.observation.answer })),
        commonSlotIds: summary.commonSlots.map((slot) => slot.id), bookingCreated: false };
      summary.receiptPath = await publishReceipt(receiptDirectory, `${meeting.meetingId}.json`, receipt);
    }
    return summary;
  };
  try {
    stopped();
    state = await store.read();
    if (state) validateState(state, binding, meeting);
    else {
      if (mode === 'recover') fail('nothing_to_recover', 'No uncertain creation is saved for this meeting.');
      if (Date.parse(meeting.slots[0].start) <= now()) fail('invalid_meeting', 'Both slots must still be in the future when starting a meeting.');
      state = { version: 1, binding, askerId: null, entries: meeting.participants.map(freshEntry) };
      await save();
    }
    let rooms;
    try { rooms = await client.rooms.list(); }
    catch { fail('read_failed', 'Could not verify the private room and participant roster. No questions were created.'); }
    stopped();
    assertRoom(rooms, room, meeting.participants);
    if (attach) {
      const entry = state.entries.find((e) => e.participantId === attach.participantId);
      if (entry.phase !== 'sending') fail('nothing_to_recover', 'Only an uncertain creation can attach an existing Question.');
      const q = await get(attach.questionId);
      const observation = verify(q, entry, attach.questionId);
      state.askerId ??= q.asker.id;
      Object.assign(entry, { phase: 'asked', questionId: q.id, candidateId: null, createdAt: q.created_at, expiresAt: q.expires_at, observation });
      await save();
    }
    // A prior uncertain send blocks every new send, including if another entry appears earlier.
    const blocked = state.entries.some((e) => e.phase === 'sending');
    for (const entry of state.entries) {
      stopped();
      if (entry.phase === 'unasked' && mode === 'send' && !blocked) {
        if (Date.parse(meeting.slots[0].start) <= now() + TTL * 1000 + SEND_MARGIN_MS) break;
        entry.key = `availability-${randomUUID()}`;
        entry.request = requestFor(meeting, entry.participantId, entry.key);
        entry.intentAt = new Date(now()).toISOString();
        entry.phase = 'sending';
        await save(); // Durably record the exact request before its only POST attempt.
        stopped();
        let q;
        try { q = await client.questions.ask(room, entry.request); }
        catch { return await result(); }
        if (uuid(q?.id)) { entry.candidateId = q.id; await save(); }
        let observation;
        try { observation = verify(q, entry, q?.id); }
        catch { return await result(); }
        state.askerId ??= q.asker.id;
        Object.assign(entry, { phase: 'asked', questionId: q.id, candidateId: null, createdAt: q.created_at, expiresAt: q.expires_at, observation });
        await save();
      }
      if (entry.phase === 'asked') {
        const q = await get(entry.questionId);
        entry.observation = verify(q, entry, entry.questionId);
        await save();
      }
    }
    stopped();
    return await result();
  } finally { await store.close(); }
}
