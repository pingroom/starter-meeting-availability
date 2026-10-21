import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coordinateAvailability } from './availability.js';
import { offline, TOKEN, ROOM, NOW, PEOPLE, meeting } from './offline.js';

const temporary = await mkdtemp(join(tmpdir(), 'pingroom-availability-demo-'));
try {
  for (const [scenario, choices] of Object.entries({
    shared: { [PEOPLE[0]]: 'both', [PEOPLE[1]]: 'b' },
    no_overlap: { [PEOPLE[0]]: 'a', [PEOPLE[1]]: 'b' },
    incomplete: { [PEOPLE[0]]: 'both', [PEOPLE[1]]: null },
  })) {
    const transport = offline({ choices });
    const input = { ...transport, token: TOKEN, room: ROOM, meeting,
      directory: join(temporary, scenario, 'state'), receiptDirectory: join(temporary, scenario, 'receipts'), now: () => NOW };
    const first = await coordinateAvailability({ ...input, mode: 'send' });
    const again = await coordinateAvailability({ ...input, mode: 'check' });
    console.log(JSON.stringify({ scenario, status: first.status, commonSlots: first.commonSlots?.map((s) => s.id) ?? null,
      rerun: again.status, createdQuestions: transport.calls.filter((c) => c.method === 'POST').length }));
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
