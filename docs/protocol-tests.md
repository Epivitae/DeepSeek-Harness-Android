# DSH web protocol — verification evidence & client implementation notes

This document records what the Android client's data layer was built against and
how it was verified, plus how to run the tooling. Companion to
[`PROTOCOL-NOTES.md`](PROTOCOL-NOTES.md) (Lead's raw probe notes).

- Host: `tri` (`127.0.0.1:3080`), `dsh web` version **0.2.1-rc.2**
- Client target: Android WebView 91 (Chrome 91), classic scripts only
- Verified: 2026-10-24, against a live host. Token comes from the `dsh web`
  startup URL (local dev tooling reads the token file by default);
  it rotates when `dsh-web.service` restarts
  (`journalctl -u dsh-web --no-pager | grep 'dsh web:' | tail -1`).
- Everything below was exercised against the real server; fixtures under
  `tools/fixtures/` (local, gitignored) are raw recorded frames, not hand-written mocks.

## 1. Authentication

```
GET /?token=<TOKEN>
  -> HTTP 303 See Other, Location: ./
     Set-Cookie: dsh-auth-<hash>=v1.<payload>.<sig>; Max-Age=2592000;
                 Path=/; HttpOnly; SameSite=Strict
```

Every `/api/*` HTTP request **and** the `/api/remote.mux` WebSocket handshake
must carry that cookie. Verified:

- Missing/bogus cookie → **HTTP 401** with a plain-text body `unauthorized`
  (`tools/fixtures/errors.json` → `unauthorized`). There is no JSON envelope.
- The cookie is bound to the Host authority (`127.0.0.1:3080`), so a client that
  talks to a different host/port must obtain a fresh cookie from that origin.
- Token errors are surfaced by `DSHClient` as `onAuthError(err)` with
  `err.code === 'unauthorized'`, and the client stops retrying. The native shell
  must re-run the token→cookie exchange and reload the page.

## 2. Unary RPC (verified)

`POST /api/<endpoint>`, `content-type: application/json`

```json
{"type":"client-request","rpcId":"<uuid>","method":"<endpoint>","payload":{"args":{ ... }}}
```

Success: `{"type":"server-response","rpcId":"<same>","result":{"ok":true,"value": ...}}`
Logical failure: HTTP 200 with
`{"type":"server-response","rpcId":"<same>","result":{"ok":false,"error":{"code","message","details"}}}`

| endpoint | args | verified result |
| --- | --- | --- |
| `session/list` | `{"_request":{}}` | `{items:[{sessionId,updatedAt,running,blank,cwd,agentAvailable,origin?,parentSessionId?,projections:{kind,asOfSeq,values:{title,tokenUsage,modelSelection,permissions,turnOutline,sessionListMetadata,...}}}]}` |
| `session/create` | `{"request":{"cwd":"/abs/path"}}` | `{sessionId:"session-…",agentPreset:"standard"}` |
| `session/prompt` | `{"request":{"requestId":"<uuid>","sessionId","mode":"queue","content":[{"type":"text","text":"…"}],"clientTimeZone":"Asia/Shanghai"}}` | `{accepted:true}` |
| `session/page` | `{"request":{"address":{"kind":"session","sessionId"},"throughSeq":<opening cursor>,"beforeSeq":<oldest loaded seq>,"maxMessages":N}}` | `{records:[{type:"event",event}] \| [], hasMore:boolean}` |
| `session/modelCatalog` | `{}` | `{default:{…}, groups:[{id,name,models:[{id,name,reasoning?:{efforts,defaultEffort}}]}]}` |
| `session/rename` | `{"request":{"sessionId","title"}}` | `{title, seq}` (new `session/title` event) |
| `session/selectModel` | `{"request":{"sessionId","provider","model","reasoningEffort"}}` | ack value; effect visible as `model/selection` event / projections |
| `session/cancel` | `{"request":{"sessionId"}}` | ack value; effect visible as `turn/end` with `reason.kind:"aborted"` |

HTTP-level error cases observed (important: they are **not** envelopes):

| case | response |
| --- | --- |
| unknown endpoint path `/api/no/suchEndpoint` | HTTP 404, body `not found` |
| malformed JSON body | HTTP 400, body `body is not JSON` |
| bad/expired cookie | HTTP 401, body `unauthorized` |
| valid endpoint, wrong args | HTTP 200, `result.ok:false`, `error.code:"gateway/arguments-invalid"`, message names the missing field |
| valid endpoint, missing session | HTTP 200, `result.ok:false`, `error.code:"session/not-found"`, `details:{sessionId}` |

## 3. Streams — `/api/remote.mux` (verified)

One multiplexed WebSocket. Open a logical stream:

```json
{"type":"open","streamId":"<uuid>","endpoint":"session/follow",
 "payload":{"args":{"request":{"address":{"kind":"session","sessionId":"session-…"},
                              "maxMessages":40,"assistantStream":true}}}}
```

Server frames (all carry `streamId`):

- `{"type":"item","streamId","value":…}` — snapshot / durable event / assistant-stream
- `{"type":"error","streamId","error":{"code","message","details"}}`
- `{"type":"end","streamId"}`
- Cancel: `{"type":"cancel","streamId"}`

### `session/follow` item values

1. **Snapshot** (first item, replaces local state):
   `{type:"snapshot", header:{version,id,createdAt,cwd,isSeeded,agentPreset}, cursor:N, records:[{type:"event",event}], hasMore:bool, projections:{asOfSeq,values:{...}}, assistantStream?:{revision,activeAttempt?:{attemptId,startedAfterSeq,turn,step,nextIndex,stream:[...]}}}`
2. **Durable events** `{type:"event",event:{type,seq,time,data,...}}`, gap-free and
   strictly increasing after the snapshot cursor.
3. **Live assistant output** `{type:"assistant-stream",frame:{…}}`:
   - `start`  `{attemptId, revision, turn, step, startedAfterSeq}`
   - `chunk`  `{attemptId, revision, index, time, chunk}` where `chunk` is a
     `StreamChunk`: `block-start` / `block-end` / `text-delta` /
     `reasoning-delta` / `tool-call-delta` / `usage` / `finish`.
     `index` is a dense per-attempt frame position (used for dedupe).
   - `end`    `{attemptId, revision, index, outcome}` with
     `outcome.kind:"committed"` + `{eventType:"assistant/message"|"assistant/attempt", seq}`
     or `outcome.kind:"abandoned"`.

**Ordering observed:** live `end` (committed, seq S) arrives *just before* the
durable `assistant/message` seq S. Transcript promotion keys off that: the live
item keeps its id and is replaced by the durable content, so no duplicate bubble
and no DOM flicker.

**Late follow while a model is streaming:** the snapshot's
`assistantStream.activeAttempt` contains the partial attempt as compact stream
records (`nextIndex` = count already covered). Expand forms:
`{type:"chunk",chunk}` and compact `text-chunks` / `reasoning-chunks` /
`tool-call-chunks` (`{type,time0,index,dt,texts|args[,id,name]}` — deltas are
`texts[i]`/`args[i]`, timestamps are cumulative `time0 + dt[i-1]`). Live frames
with `revision <= assistantStream.revision` are replays and must be ignored;
frames with `index < nextIndex` are already-covered chunks.

**Cancel is fire-and-forget for `session/follow`:** after a snapshot, sending
`{"type":"cancel",streamId}` produced **no** `end` frame within 5 s (captured in
`errors.json` → `followCancel`). `unfollow()` therefore sends cancel and drops
local interest; the host emits `end` for terminal cases (e.g. stream errors) but
not for a user-initiated unfollow.

**Stream error frame** (verified by following a non-existent session):

```json
{"type":"error","streamId":"…","error":{"code":"session/not-found",
 "message":"session \"session-does-not-exist\" not found",
 "details":{"sessionId":"session-does-not-exist"}}}
```

### Durable event types the transcript consumes

`turn/start`, `step/start`, `turn/end`, `user/message`, `assistant/message`,
`assistant/attempt`, `tool/call`, `tool/result`, `session/title`. Everything
else (system/developer messages, request/*, inbox splices, session-log-*,
job/*, workspace changes, …) is ignored safely.

Shapes that matter:

- `user/message.data = {content:[{type:"text",text}], source:{kind:"user"|…}}`;
  only `source.kind === "user"` is a human prompt. Synthetic context injections
  observed: `runtime-context`, `skill-catalog`, `time-context` — hidden.
- `assistant/message.data = {turn, step, message:{role, content:[{type:"text"|"reasoning"|"tool-call",…}], source, id}, usage?, stream?, interrupted?:true}`.
  Content is final text/reasoning (empty reasoning blocks possible).
- `tool/call.data = {turn, step, callId, name, arguments}` where `arguments` is a
  JSON **string**.
- `tool/result.data = {turn, step, message:{role:"tool", toolCallId, source:{kind:"tool",callId}, content:[{type:"text",text}], isError}, error?, meta?}`;
  status is `error` when `message.isError === true` or `data.error` is present.
- `turn/end.data = {turn, reason:{kind}}` with `kind` ∈
  `completed | aborted{reason:{kind:"user"|…}} | blocked | error{error} |
  max-tokens | interrupted | forked`.
- `session/title.data = {title, messageSeqs?, source:{kind:"fallback"|"provider",…}}`;
  fallback title lands first, provider title replaces it later (last wins).

## 4. Client implementation

### `web/api.js` — `window.DSHClient` (classic script, Node-loadable)

```js
var client = new DSHClient({
  baseUrl,          // default: location.origin (dev proxy / WebView: same origin)
  onSnapshot(v), onEvent(v), onAssistantFrame(v), onStreamEnd(v),
  onStatus(status), onError(err), onAuthError(err),
  // optional for Node tooling:
  WebSocketImpl, fetchImpl, headers
});
```

| method | behaviour |
| --- | --- |
| `connect()` → Promise | opens the one mux socket; resolves on open; rejects on auth error; network failures keep retrying with backoff (promise rejects on the first failed attempt, reconnects in the background) |
| `listSessions()` | `session/list` → `items[]` |
| `createSession({cwd})` | `session/create` |
| `follow(sessionId, {maxMessages=40})` | opens `session/follow`; resolves when the snapshot arrives; auto re-follows after reconnect |
| `unfollow()` | sends stream cancel, drops follow state, keeps socket |
| `sendPrompt(sessionId, text, {mode='queue', clientTimeZone})` | `session/prompt` |
| `cancel(sessionId)` | `session/cancel` |
| `pageOlder(sessionId, {throughSeq, beforeSeq, maxMessages=30})` | `session/page` → `{records, hasMore}` |
| `modelCatalog()` | `session/modelCatalog` |
| `selectModel(sessionId, {provider, model, reasoningEffort})` | `session/selectModel` |
| `renameSession(sessionId, title)` (alias `rename`) | `session/rename` |
| `close()` / `reopen()` | teardown / re-arm after terminal auth failure |

Status values: `connecting` → `connected` → `reconnecting` → `connected`, or
`offline` (closed/auth failure). Errors from RPCs are `Error` objects with
`.code` (protocol code, `http-<n>`, `network`, `timeout`, `unauthorized`, …)
and `.details`.

Reconnect: WS close after a successful open → exponential backoff
1s,2s,4s,8s,16s,30s (+jitter, capped), re-open socket, re-follow the active
session (a fresh snapshot rebuilds the transcript). Liveness timer every 30 s
closes sockets stuck in CONNECTING, and forces a reconnect if an active follow
sees no frame for 90 s (zombie socket detection; browsers auto-answer
protocol-level pings, so a quiet-but-healthy stream is left alone).

Auth detection in a browser is indirect (WS handshake errors are opaque): when a
handshake fails, the client probes an authenticated unary call and only reports
`onAuthError` if that returns 401; otherwise it keeps reconnecting.

### `web/transcript.js` — `window.DSHTranscript`

```js
var t = new DSHTranscript();
t.reset(snapshotValue);              // opening snapshot (replaces all state)
t.applyEvent(eventValue);            // {type:'event', event}
t.applyAssistantFrame(frameValue);   // {type:'assistant-stream', frame}
t.applyStreamEnd(frameValue);        // assistant-stream end frame (or transport end: no-op)
t.prependRecords(records, hasMore);  // session/page result (older history)
t.items / t.title / t.running / t.cursor / t.hasMore / t.lastSeq / t.header / t.streamingItem
```

Items (stable ids; UI can diff DOM):

```js
{id:'u-<seq>',        kind:'user',      text, seq, time}
{id:'a-<attemptId>',  kind:'assistant', reasoning, text, blocks:[{type,text}],
                      streaming, interrupted?, attemptId?, seq?, time}
{id:'t-<callId>',     kind:'tool',      callId, name, argsText,
                      status:'running'|'ok'|'error', resultText, seq?, time}
{id:'n-…',            kind:'notice',    tone:'info'|'warn'|'error', text, seq?}
```

Semantics verified by `tools/test-transcript.mjs`:

- `applyStreamEnd` only reacts to the generation-level assistant-stream `end`
  frame (which has `outcome`); the transport `end` envelope is a no-op, so an
  app that forwards both must not mark a live attempt as interrupted.
- Snapshot rebuild: durable events → items; synthetic user messages hidden;
  title from the last `session/title`; `running` from the last open turn;
  `cursor`/`hasMore` from the snapshot.
- Live assistant text/reasoning grow from deltas; `block-end` is authoritative
  for the block text; ids stay stable (`a-<attemptId>`) when the durable
  `assistant/message` commits (no duplicate).
- Snapshot `assistantStream.activeAttempt` replay + revision/index dedupe.
- `tool/call` + `tool/result` merge into one card keyed by `callId`; live
  `tool-call-delta` creates the provisional card; `isError` → `status:'error'`.
  Tool cards render after the assistant bubble that requested them.
- `abandoned` outcome / `interrupted:true` mark `interrupted`; `turn/end`
  `aborted`/`interrupted`/`max-tokens`/`error`/`blocked` add a notice; a
  completed turn adds nothing.
- Unknown/internal events and unknown chunk types are safely ignored.
- `prependRecords` puts older history first, pairs tool calls/results across the
  page boundary, ignores duplicate pages, and updates `hasMore`.

All three files are ES2019/ES2020-safe classic scripts (no modules, no
`crypto.randomUUID`, no `Array.prototype.at`, no `Object.hasOwn`; `Map`,
`Promise`, `fetch`, `AbortController`, `Intl` are used — all present in Chrome
91). They attach to `window.DSHClient` / `window.DSHTranscript`; Node tooling
loads the same files through `module.exports`.

## 5. Dev proxy (`tools/dev-proxy.mjs`)

```bash
node tools/dev-proxy.mjs            # foreground, prints the URL
# or, as used during development:
nohup node tools/dev-proxy.mjs > /tmp/dev-proxy.log 2>&1 &
```

- Serves `web/` at `http://127.0.0.1:8099/index.html`
  (no-store; `/` → `index.html`; `/favicon.ico` → 204).
- Proxies `POST /api/*` to `http://127.0.0.1:3080` **with the auth cookie
  injected server-side**, mirroring production same-origin semantics (the page
  never sees the token/cookie). On upstream 401 it re-reads the token file,
  re-exchanges the token for a cookie and retries once.
- Tunnels `ws://127.0.0.1:8099/api/remote.mux` to the upstream WS (raw
  pass-through of the 101 handshake and frames, cookie injected; same 401
  retry). This is what makes the page's same-origin `WebSocket` work in dev.
- Static root can be overridden with `--root`, upstream with `--upstream`,
  token file with `--token-file`, port with `--port`.

## 6. Screenshots (`tools/shot.mjs`)

```bash
node tools/shot.mjs                        # -> /tmp/dsh-ui-390.png, /tmp/dsh-ui-960.png
node tools/shot.mjs --url '…?mock=1'       # custom URL (app.js' fixture mock mode)
```

Playwright's Chromium (`/root/ui-tools/node_modules/playwright-core`, binary
`/usr/bin/chromium`) at 390x844 and 960x540, deviceScaleFactor 1, Chrome 91
mobile UA, waits up to 8 s for `#app[data-ready="1"]`, prints console/page
errors. Verified against the Lead's UI: session list renders, 41 sessions, and
a browser-side `DSHClient` list+follow+transcript run passes on the test session.

## 7. Tests

```bash
node tools/test-transcript.mjs    # offline; 114 assertions, no network/LLM
node tools/test-live.mjs          # live through the dev proxy (:8099), 26 checks
node tools/test-capture.mjs       # re-record fixtures from the live host (1 prompt!)
```

`tools/test-transcript.mjs` replays the recorded fixtures and also unit-tests
`DSHClient` envelope/error handling and stream-frame routing with a fake
`fetchImpl` (no sockets needed).

`tools/test-live.mjs` (read-only, exits 0 with `SKIP` if the proxy is down)
verifies: connect status transitions, `session/list` (41 sessions), `follow`
snapshot delivery over the mux socket, transcript on the real snapshot,
**drop the socket → reconnect → automatic re-follow → fresh snapshot**,
`session/page`, `unfollow`, `close`, and that no transport/auth errors fired.

### Fixtures (`tools/fixtures/`, local only)

Recorded 2026-10-24 from the live host by `tools/test-capture.mjs`:

| file | contents |
| --- | --- |
| `follow-live.json` | create session → follow → one tiny prompt → every frame until commit (empty snapshot, `assistant-stream` start/chunk/end, `assistant/message` seq 18, titles 14/21, `turn/end`) |
| `follow-snapshot.json` | post-turn re-follow snapshot: 22 durable records incl. synthetic user context events |
| `session-list.json` / `session-create.json` / `session-rename.json` / `session-page.json` / `model-catalog.json` | unary RPC responses |
| `errors.json` | 401/404/400 HTTP errors, `result.ok:false` envelopes, WS error frame, follow-cancel probe |

Recorded throwaway session: `<test-session-id>`
(renamed `[protocol test] transcript fixture 769c4f`). Prompt:
`Reply with exactly: pong. Do not use any tools.` → `pong`.
The capture script never touches the user's live session
(an active user session) or a previous probe; re-running it
creates a new throwaway session and costs one short prompt.

## 8. Known limitations / notes

- `session/follow` cancels are fire-and-forget (no `end`); there is no server
  acknowledgement to wait for.
- `pageOlder` needs `throughSeq` = the opening snapshot cursor and `beforeSeq` =
  the oldest loaded event seq; the first page is usually empty for short
  sessions. Very old tool/call events paged in after their result stays paired
  (card keeps the result) but cannot be repositioned above already-rendered
  items.
- Approval prompts / user questions are not rendered by this client
  (`danger-full-access` deployment never asks); `turn/end` `blocked` shows a
  notice.
- Assistant `tool-addition` / `tool-removal` surface blocks are ignored; the
  paired `tool/call`/`tool/result` events drive tool cards.
- `session/list` items include subagent sessions (`origin:"subagent"`,
  `parentSessionId`); the UI may filter them.
- Token rotation is handled by the dev proxy and by re-auth in the native shell;
  a browser page that outlives the cookie gets `onAuthError` and stops.
