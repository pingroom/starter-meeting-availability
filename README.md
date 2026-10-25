# PingRoom meeting availability starter

Ask 2–5 named participants which of two UTC meeting slots they can attend. Each person gets a separate private PingRoom question with **A only**, **B only**, **Both slots**, and **Neither**. The application reports an intersection only after every participant has answered.

This records stated availability. It does not read calendars, reserve a slot, send invitations, or create a booking.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux, with persistent private local storage. Choose **Use this template**, clone your repository, then run:

```sh
npm ci
npm run demo
npm test
```

The demo uses the real SDK with an in-memory HTTP transport. It shows a shared slot, no overlap, and an incomplete response set, then repeats the reads without creating more questions. It needs no credentials, makes no network requests, and removes its temporary files. Installation requires npm access.

## Connect and choose participants

1. Install or open [PingRoom](https://pingroom.io/i). The connecting account and all participants must belong to one **standard private room**. A participant can be the connecting account.
2. Run `npm run connect` and approve the printed link. To select another granted room, run `npm run connect -- --room ROOM_CODE`. The connection needs `pingroom:rooms:read` and `pingroom:questions:ask`, plus access to that room. Normal sending permissions and quotas apply.
3. Run `npm run inspect`. Match the returned member UUIDs to your intended participants; display names alone do not establish identity.
4. Copy `examples/meeting.example.json` to ignored `meeting.local.json`. Replace the sample people and dates with your meeting.

```json
{
  "meetingId": "planning-042",
  "title": "Planning session",
  "slots": [
    { "id": "a", "start": "2026-10-22T09:00:00Z", "end": "2026-10-22T09:30:00Z" },
    { "id": "b", "start": "2026-10-22T11:00:00Z", "end": "2026-10-22T11:30:00Z" }
  ],
  "participants": [
    { "id": "11111111-1111-4111-8111-111111111111", "label": "Alex" },
    { "id": "22222222-2222-4222-8222-222222222222", "label": "Sam" }
  ]
}
```

Use two future, nonoverlapping slots in A-then-B order, each at most eight hours long. Dates use exactly `YYYY-MM-DDTHH:mm:ssZ`. New questions are sent only when slot A starts more than **16 minutes** away: a fixed 15-minute answer window plus one minute of margin. If that window closes before all participants are asked, the result stays incomplete.

Meeting IDs use 1–64 letters, digits, `_`, or `-`. Titles use 1–80 printable ASCII characters and participant labels 1–60, without leading or trailing spaces. Participant UUIDs are lowercase and distinct. Keep the meeting, participant order, room, and connection unchanged across retries; revised plans need a new meeting ID.

```sh
npm start       # Send each unasked participant one question; read known outcomes.
npm run check   # Read outcomes without creating questions.
```

Each command makes one pass and exits. Run `check` again as answers arrive. Sending uses explicit `target_user_id`; another room member cannot answer for that participant. The returned answer must contain that exact server-authenticated UUID.

## Configuration

Pairing saves credentials privately in `.pingroom/credentials.json` and keeps its pairing record for recovery. Interrupted pairing reuses the saved link. An approved pairing is saved before room validation, so you can retry with `--room` if the default room is unsuitable. An existing credential file is never overwritten automatically.

Before registration, setup saves a private creation intent. A lost registration or pairing response leaves that intent in place; rerunning setup sends no new request. If creation is uncertain or the link expires, inspect Connected Agents and resolve or revoke the old robot before deliberately archiving `.pingroom/pairing.json` for a new setup. Do not discard the record just to obtain another link.

Alternatively, copy `.env.example` to `.env` and supply both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. A complete pair overrides saved credentials; partial or blank values fail. Shell variables take precedence. `MEETING_FILE`, `STATE_DIR`, and `RECEIPT_DIR` override local paths. All relative paths, including `.env`, resolve from the project directory.

## Results and uncertain creation

| Status / exit code | Meaning |
| --- | --- |
| `complete` / `0` | Everyone answered; `commonSlots` contains the intersection. An empty array means no overlap. |
| `incomplete` / `3` | Someone is unasked, pending, expired, or cancelled. `commonSlots` is `null`. |
| `incomplete` / `4` | A participant has `create_unknown`; no further questions will be sent until recovery. |
| `stale` / `2` | Slot A has started. The response history remains, but no current slot suggestion is made. |
| Error / `1` | Input, access, response, storage, or transport validation failed. No shared-slot result is returned. |

A complete result writes a private receipt in `receipts/<meetingId>.json`. Repeated checks verify current remote state and reuse the identical receipt. A read failure cannot return an old complete result. Answers are immutable in PingRoom; changed or redacted responder data is refused. Names and avatars are excluded from receipts.

The exact request, fixed TTL, correlation, and idempotency key are saved and synced **before** each creation POST. A crash, lost response, or invalid create response leaves `create_unknown`. Rerunning never automatically repeats that POST or sends to later participants.

Find the original question in the originating robot's history or your application logs, then attach its UUID to the affected participant:

```sh
npm run recover -- PARTICIPANT_UUID QUESTION_UUID
npm start
```

Recovery checks the complete saved prompt, options, room, target, correlation, structured data, lifetime, and asking registration. It does not create questions. A returned `candidateId` is only a clue until verification succeeds. If you cannot locate the question, retain the journal and investigate; absence from a limited history view does not prove creation failed. Do not delete state to force a retry.

## Storage and adaptation

One process may use a state directory. After a crash, verify no process is using it before removing `.meetings/.lock` or `.pingroom/.lock`. Restore corrupt state from a valid backup. Conflicting receipts are preserved. The state directory supports at most 100 meetings; archive completed journals and matching receipts together while retaining replay history.

Files use `0600` and directories `0700` on POSIX. Credentials, meeting configuration, journals, and receipts are ignored by Git. Keep custom paths private and out of source control. Input files are bounded to 16 KiB, journal files to 64 KiB, and HTTP response bodies to 512 KiB. Requests use the official API origin, refuse redirects, and have a five-second deadline through body consumption, including stalled or empty streams.

`src/availability.js` exports `coordinateAvailability` for schedulers and workflow tools. `src/model.js` owns the intersection and verification rules. Add any calendar integration as a separate reviewed step that rechecks availability and handles concurrent bookings; this starter performs no external action beyond asking the configured people.

Unlike [task claim](https://github.com/pingroom/starter-task-claim), where the first room answer assigns one person, this workflow requires independent answers from every named participant. It uses ordinary targeted Questions, not the unreleased poll API.

The official [PingRoom SDK](https://github.com/pingroom/sdk) is pinned to `0.6.0` with a lockfile and a 14-day minimum release age. CI runs offline tests and the demo on Node.js 22 and 24. No live phone delivery is tested.

MIT licensed; see [LICENSE](LICENSE).
