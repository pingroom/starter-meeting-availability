import { makeClient } from './client.js';
import { loadEnvironment, loadConfig, loadConnection, credentialDirectory } from './config.js';
import { coordinateAvailability } from './availability.js';
import { connect } from './connect.js';
import { assertRoom, uuid } from './model.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Error('Stopped.')));
process.once('SIGTERM', () => controller.abort(new Error('Stopped.')));
try {
  const [command, ...args] = process.argv.slice(2);
  await loadEnvironment();
  if (command === 'connect') {
    if (args.length && (args.length !== 2 || args[0] !== '--room')) throw new Error('Use npm run connect [-- --room ROOM_CODE].');
    console.log('Install or open PingRoom and sign in: https://pingroom.io/i');
    const result = await connect({ client: makeClient({ pairing: true, signal: controller.signal }), directory: credentialDirectory,
      requestedRoom: args[1]?.toUpperCase(), signal: controller.signal });
    console.log(`Connected to ${result.room}. Credentials are private in .pingroom/. Run npm run inspect to see participant UUIDs.`);
  } else if (command === 'inspect' && args.length === 0) {
    const connection = await loadConnection();
    const client = makeClient({ token: connection.token, signal: controller.signal });
    const room = assertRoom(await client.rooms.list(), connection.room);
    console.log(JSON.stringify({ room: connection.room, members: room.members.filter((m) => uuid(m?.user_id)).map((m) => ({ id: m.user_id, name: m.name ?? m.user?.name ?? null, role: m.role })) }, null, 2));
  } else if (['send', 'check', 'recover'].includes(command)) {
    if (command === 'recover' ? args.length !== 2 : args.length !== 0) throw new Error('Use npm run recover -- PARTICIPANT_UUID QUESTION_UUID, or start/check without arguments.');
    const config = await loadConfig();
    const result = await coordinateAvailability({ ...config, mode: command,
      client: makeClient({ token: config.token, signal: controller.signal }), signal: controller.signal,
      ...(command === 'recover' ? { attach: { participantId: args[0], questionId: args[1] } } : {}) });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'complete' ? 0 : result.status === 'stale' ? 2 : result.participants.some((p) => p.status === 'create_unknown') ? 4 : 3;
  } else throw new Error('Use connect, inspect, start, check, or recover from package.json scripts.');
} catch (error) {
  // SDK error bodies can contain remote content. Only known local errors are shown verbatim.
  console.error(error.name === 'PingRoomError' ? 'PingRoom request failed. Check the connection, access, and saved state.' : `${error.code || 'error'}: ${error.message}`);
  process.exitCode = 1;
}
