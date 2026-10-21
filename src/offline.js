import { PingRoom } from '@pingroom/sdk';

export const TOKEN = 'offline-example-token';
export const ROOM = 'DEMO12345678';
export const ROBOT = 'af655e77-a9d5-421e-ab22-5af24986f824';
export const PEOPLE = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
export const NOW = Date.parse('2026-10-21T05:00:02Z');
export const meeting = {
  meetingId: 'planning-042', title: 'Planning session',
  slots: [{ id: 'a', start: '2026-10-22T09:00:00Z', end: '2026-10-22T09:30:00Z' },
    { id: 'b', start: '2026-10-22T11:00:00Z', end: '2026-10-22T11:30:00Z' }],
  participants: [{ id: PEOPLE[0], label: 'Alex' }, { id: PEOPLE[1], label: 'Sam' }],
};
export const room = { invite_code: ROOM, type: 'standard', is_public: false,
  members: PEOPLE.map((id, i) => ({ user_id: id, name: meeting.participants[i].label, role: i === 0 ? 'owner' : 'member' })) };

export function questionFor(body, id) {
  return {
    id, kind: 'question', is_handoff: false, prompt: body.prompt, context: body.context,
    options: body.options.map((o) => ({ ...o, primary: false, destructive: false })), text_input: null,
    responder_scope: body.responder_scope, target_user_id: body.target_user_id, resolution_policy: 'first', results: null,
    state: 'pending', answer: null, created_at: '2026-10-21T05:00:00+00:00', expires_at: '2026-10-21T05:15:00+00:00', resolved_at: null,
    correlation_id: body.correlation_id, reply_to: null, data: body.data,
    room: { code: ROOM, name: 'Planning room', icon: '📅', color: '#123456' }, room_code: ROOM,
    asker: { type: 'agent', id: ROBOT, handle: 'planning-demo', display_name: 'Planning', avatar_url: null },
  };
}
export function answerQuestion(q, value, changes = {}) {
  return { ...structuredClone(q), state: 'answered', resolved_at: '2026-10-21T05:00:01+00:00',
    answer: { value, label: q.options.find((o) => o.value === value)?.label ?? 'Unknown', text: null,
      responder: { id: q.target_user_id, display_name: 'Teammate', profile_image_url: null, emoji: null, color: null },
      answered_at: '2026-10-21T05:00:01+00:00' }, ...changes };
}

/** Only this local transport runs; unknown requests never fall through to a network. */
export function offline({ choices = { [PEOPLE[0]]: 'both', [PEOPLE[1]]: 'b' }, onAsk, onGet, onRooms } = {}) {
  const calls = [], questions = new Map();
  let count = 0;
  const client = new PingRoom({ token: TOKEN, baseUrl: 'https://availability.invalid', timeoutMs: 1000,
    fetch: async (url, init) => {
      const u = new URL(url);
      if (u.origin !== 'https://availability.invalid') throw new Error('Unexpected offline origin.');
      const call = { method: init.method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null,
        idempotencyKey: new Headers(init.headers).get('Idempotency-Key') };
      calls.push(call);
      if (call.method === 'GET' && call.path === '/api/agent/rooms') return onRooms ? onRooms() : Response.json([room]);
      if (call.method === 'POST' && call.path === `/api/agent/rooms/${ROOM}/questions`) {
        const id = `cccccccc-cccc-4ccc-8ccc-${String(++count).padStart(12, '0')}`;
        const q = questionFor(call.body, id);
        questions.set(id, q);
        return onAsk ? onAsk(structuredClone(q), call, questions) : Response.json(q, { status: 201 });
      }
      if (call.method === 'GET' && call.path.startsWith('/api/agent/questions/')) {
        const id = call.path.split('/').at(-1), q = questions.get(id);
        if (!q) return Response.json({ code: 'not_found' }, { status: 404 });
        if (onGet) return onGet(structuredClone(q), questions);
        const value = choices[q.target_user_id];
        return Response.json(value ? answerQuestion(q, value) : q);
      }
      throw new Error('Unexpected offline request.');
    },
  });
  return { client, calls, questions };
}
