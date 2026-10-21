import { createHash } from 'node:crypto';

export const TTL = 900;
export const SEND_MARGIN_MS = 60_000;
export const uuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const roomCode = (v) => typeof v === 'string' && /^[A-Z0-9]{12}$/.test(v);
export const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const exactKeys = (v, keys) => record(v) && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
export class AvailabilityError extends Error {
  constructor(code, message) { super(message); this.name = 'AvailabilityError'; this.code = code; }
}
export const fail = (code, message) => { throw new AvailabilityError(code, message); };
export function canonical(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  fail('invalid_value', 'Expected JSON values.');
}
export const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}
const ascii = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value && value.length > 0;
export function validateMeeting(raw) {
  if (!exactKeys(raw, 'meetingId,title,slots,participants') || typeof raw.meetingId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.meetingId) || !ascii(raw.title, 80)
    || !Array.isArray(raw.slots) || raw.slots.length !== 2 || !Array.isArray(raw.participants)
    || raw.participants.length < 2 || raw.participants.length > 5) fail('invalid_meeting', 'Expected meetingId, title, exactly two UTC slots, and 2–5 participants.');
  for (const [index, slot] of raw.slots.entries()) {
    if (!exactKeys(slot, 'id,start,end') || slot.id !== ['a', 'b'][index]
      || !validDate(slot.start) || !validDate(slot.end) || !slot.start.endsWith('Z') || !slot.end.endsWith('Z')
      || slot.start.length !== 20 || slot.end.length !== 20 || Date.parse(slot.end) <= Date.parse(slot.start)
      || Date.parse(slot.end) - Date.parse(slot.start) > 8 * 3_600_000) fail('invalid_meeting', 'Slots must be ordered a, b with UTC YYYY-MM-DDTHH:mm:ssZ times and durations of at most eight hours.');
  }
  if (Date.parse(raw.slots[1].start) < Date.parse(raw.slots[0].end)) fail('invalid_meeting', 'Slot B must start at or after slot A ends.');
  if (raw.participants.some((p) => !exactKeys(p, 'id,label') || !uuid(p.id) || !ascii(p.label, 60))
    || new Set(raw.participants.map((p) => p.id)).size !== raw.participants.length) fail('invalid_meeting', 'Participants need distinct lowercase UUIDs and plain ASCII labels.');
  return JSON.parse(canonical(raw));
}

export const OPTIONS = Object.freeze([
  Object.freeze({ value: 'a', label: 'A only' }), Object.freeze({ value: 'b', label: 'B only' }),
  Object.freeze({ value: 'both', label: 'Both slots' }), Object.freeze({ value: 'neither', label: 'Neither' }),
]);
export function requestFor(meeting, participantId, key) {
  return {
    prompt: `Meeting: ${meeting.title}\nA: ${meeting.slots[0].start} to ${meeting.slots[0].end}\nB: ${meeting.slots[1].start} to ${meeting.slots[1].end}\nWhich UTC slots can you attend? Availability only; no booking is made.`,
    context: `Availability ${hash(meeting).slice(0, 16)}`,
    options: OPTIONS, responder_scope: 'direct', target_user_id: participantId, ttl: TTL,
    correlation_id: key, data: { meeting_id: meeting.meetingId, meeting_sha256: hash(meeting), participant_id: participantId },
    idempotencyKey: key,
  };
}

export function assertRoom(rooms, room, participants = []) {
  if (!Array.isArray(rooms) || rooms.length > 1000) fail('room_unavailable', 'Invalid room inventory.');
  const matches = rooms.filter((r) => r?.invite_code === room);
  const r = matches[0];
  if (matches.length !== 1 || r.type !== 'standard' || r.is_public !== false || !Array.isArray(r.members) || r.members.length > 1000) fail('room_unavailable', 'Use a granted standard private room with a visible human roster.');
  const ids = new Set(r.members.filter((m) => uuid(m?.user_id)).map((m) => m.user_id));
  if (ids.size < 2 || participants.some((p) => !ids.has(p.id))) fail('room_unavailable', 'Every participant must currently belong to the shared private room.');
  return r;
}

export function assertQuestion(q, request, { room, questionId, askerId, createdAt, expiresAt, firstSlot, now }) {
  const mismatch = () => fail('question_mismatch', 'Question identity, content, room, target, timing, or answer differs from the saved request.');
  if (!record(q) || !uuid(q.id) || (questionId && q.id !== questionId) || q.kind !== 'question' || q.is_handoff !== false
    || q.room_code !== room || q.room?.code !== room || q.asker?.type !== 'agent' || !uuid(q.asker.id)
    || (askerId && q.asker.id !== askerId) || q.prompt !== request.prompt || q.context !== request.context
    || q.text_input !== null || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id
    || q.resolution_policy !== 'first' || q.results !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null
    || canonical(q.data) !== canonical(request.data) || !Array.isArray(q.options) || q.options.length !== 4
    || q.options.some((option, i) => option?.value !== OPTIONS[i].value || option.label !== OPTIONS[i].label || option.primary !== false || option.destructive !== false)
    || !validDate(q.created_at) || !validDate(q.expires_at)
    || Date.parse(q.created_at) > now + 5000 || Math.abs(Date.parse(q.expires_at) - Date.parse(q.created_at) - TTL * 1000) > 5000
    || Date.parse(q.expires_at) >= Date.parse(firstSlot) || (createdAt && q.created_at !== createdAt) || (expiresAt && q.expires_at !== expiresAt)
    || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)) mismatch();
  let answer = null;
  if (q.state === 'pending') {
    if (q.answer !== null || q.resolved_at !== null || Date.parse(q.expires_at) <= now) mismatch();
  } else {
    if (!validDate(q.resolved_at) || Date.parse(q.resolved_at) < Date.parse(q.created_at) || Date.parse(q.resolved_at) > now + 5000) mismatch();
    if (q.state === 'expired' && Date.parse(q.resolved_at) !== Date.parse(q.expires_at)) mismatch();
    if (q.state === 'cancelled' && Date.parse(q.resolved_at) >= Date.parse(q.expires_at)) mismatch();
    if (q.state !== 'answered' && q.answer !== null) mismatch();
    if (q.state === 'answered') {
      const a = q.answer, option = OPTIONS.find((o) => o.value === a?.value);
      if (!option || a.label !== option.label || a.text !== null || a.responder?.id !== request.target_user_id
        || !validDate(a.answered_at) || Date.parse(a.answered_at) !== Date.parse(q.resolved_at)
        || Date.parse(a.answered_at) >= Date.parse(q.expires_at)) mismatch();
      answer = { value: a.value, responderId: a.responder.id, answeredAt: a.answered_at };
    }
  }
  return { state: q.state, resolvedAt: q.resolved_at, answer };
}

export function summarize(meeting, entries, now) {
  const allAnswered = entries.every((entry) => entry.observation?.state === 'answered');
  const stale = Date.parse(meeting.slots[0].start) <= now;
  const commonIds = allAnswered ? ['a', 'b'].filter((id) => entries.every((entry) => [id, 'both'].includes(entry.observation.answer.value))) : null;
  return {
    meetingId: meeting.meetingId, status: stale ? 'stale' : allAnswered ? 'complete' : 'incomplete',
    commonSlots: !stale && allAnswered ? meeting.slots.filter((slot) => commonIds.includes(slot.id)) : null,
    participants: entries.map((entry, i) => ({ id: entry.participantId, label: meeting.participants[i].label,
      status: entry.phase === 'sending' ? 'create_unknown' : entry.phase === 'unasked' ? 'unasked' : entry.observation.state,
      questionId: entry.questionId, candidateId: entry.candidateId, answer: entry.observation?.answer ?? null })),
  };
}
