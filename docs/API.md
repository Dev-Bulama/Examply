# Internal API

These are the JSON endpoints and socket events used by EXAMPLY's own pages (the exam player, the labs and the live quiz). They are not a public API: every endpoint needs the user's session cookie and a CSRF token, and is rate-limited.

**Conventions**

- **CSRF:** send the token from `<meta name="csrf-token">` in the `X-CSRF-Token` header. Multipart uploads put it in the query string as `?_csrf=…`.
- **Responses:** `{ "ok": true, … }` on success, or `{ "ok": false, "error": "Human-readable message", "code": "OPTIONAL_CODE" }` with a 4xx status.
- **Ownership:** a candidate can only reach their own attempts. Anyone else gets `404`.

## Exam engine

| Method & path | Body | Returns |
|---|---|---|
| `PATCH /attempts/:uuid/answers` | `{ answers: [{ itemId, response, flagged?, timeSpent? }], pos? }` | `{ ok, saved, state, status, serverTime, expiresAt }`. Header `X-Attempt-Token` enforces single-session mode (`409` with `code: "other_session"` when the exam was reopened in another tab or device). |
| `POST /attempts/:uuid/events` | `{ type, details? }`, where type is `tab_hidden`, `fullscreen_exit`, `copy`, `paste`, etc. | `{ ok, recorded, tabSwitches, limit?, submitted? }` (`submitted` when the tab-switch limit auto-submits) |
| `POST /attempts/:uuid/section/finish` | none | `{ ok, state }` (locks the section; for timed sections) |
| `POST /attempts/:uuid/submit` | form or JSON | Redirects to `/results/:uuid`, or `{ ok, redirect }` with `Accept: application/json` |
| `POST /attempts/:uuid/items/:itemId/sql` | `{ sql }` or `{ describe: true }` | `{ ok, run: { columns, rows, truncated, ms } }` or `{ ok, schema }`. Never reveals the solution or the marking query. |
| `POST /attempts/:uuid/items/:itemId/lab` | `{ init: true }` or `{ command }` | `{ ok, output, prompt, exit }`, or `{ ok, replay, prompt }` on `init` |

**Response shapes by question type** (`response` in the answers payload):

| Type | Shape |
|---|---|
| single choice, true/false, hotspot | `{ selected: "B" }` |
| multiple response | `{ selected: ["A", "C"] }` |
| fill in the blank | `{ blanks: ["1521", "listener.ora"] }` |
| numeric | `{ value: "6.02" }` |
| matching | `{ pairs: { "L1": "R2" } }` |
| ordering | `{ order: ["I2", "I1"] }` |
| short answer, essay | `{ text: "…" }` |
| SQL | `{ sql: "SELECT …" }` |

Labs are answered on the server, one command at a time. The final state of the machine is what gets marked.

**Timer:** the server's `expiresAt` is authoritative. The client shows `expiresAt − serverTime` adjusted for clock drift, and the server rejects late writes (5-second grace) and submits expired attempts itself.

## Staff previews

| Method & path | Body | Returns |
|---|---|---|
| `POST /admin/questions/:id/sql` | `{ sql }`, `{ describe: true }` or `{ check: true }` | Query results, the schema, or the check against the model solution |
| `POST /admin/questions/:id/lab` | `{ init }`, `{ command }` or `{ reset: true }` | Output plus `tasks: [{ id, title, marks, passed }]` |

## Live quiz: Socket.IO namespace `/live`

The client connects to `io('/live', { auth: { session: <sessionId>, host?: <hostToken> } })`.

- **Host:** `host` is an HMAC of the session and host (signed with `SESSION_SECRET`), embedded in the host page.
- **Players:** they authenticate with the httpOnly cookie `lp_<sessionId>`, which `POST /play` sets. Reconnecting with it resumes the same player.
- **Connection errors:** `not_found`, `forbidden` (bad host token) and `join_first` (no valid player cookie).

**Host → server** (each with an acknowledgement callback `({ ok, error? })`):

| Event | Payload | Effect |
|---|---|---|
| `start` | none | Lobby → first question (host-paced) or running (self-paced) |
| `next` | none | question → reveal → leaderboard → next question / podium |
| `pause`, `resume` | none | Freezes or resumes the question timer |
| `kick` | `{ playerId }` | Removes a player (they cannot rejoin) |
| `end` | none | Finishes the game |

**Player → server:**

| Event | Payload | Ack |
|---|---|---|
| `answer` | `{ index, response }` (shapes as in the exam engine) | `{ ok, correct, points, score, streak }`; one answer per question |

**Server → clients:**

| Event | To | Data |
|---|---|---|
| `host` | Host sockets | Public state plus `pin`, `allPlayers[]`, `live: { answered, counts }` |
| `state` | Each player | `{ status, phase, index, total, endsAt, serverNow, question, reveal, leaderboard, me: { score, rank, streak, last, question? } }` |
| `kicked` | The removed player | none |

Questions sent to players never include the answer key. `reveal` is only present after the question closes. Scoring: 500 for a correct answer, plus up to 500 for speed (linear over the timer), plus a streak bonus of 100 × (streak − 1), capped at 500.

## Operations

| Method & path | Notes |
|---|---|
| `GET /healthz` | `{ ok: true, installed }` (no auth) |
| `GET /cron/run?token=CRON_TOKEN` | Runs due scheduled tasks and queued jobs: emails, imports, AI, analytics, reminders, order expiry |
| `POST /webhooks/paystack` | Raw body, verified with HMAC-SHA512 of the secret key (`x-paystack-signature`); idempotent |
| `GET /theme.css` | Brand colours as CSS variables (cacheable) |
