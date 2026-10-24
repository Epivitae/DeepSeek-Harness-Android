# DSH Web API — wire protocol notes (v0.2.1-rc.2)

Verified against a live `dsh web` instance (v0.2.1-rc.2). The startup URL has the
form `http://127.0.0.1:3080/?token=<TOKEN>`; the token changes whenever the web
service restarts, so refresh it from the terminal running `dsh web` (or its
service logs).

The DSH web front end talks to the host with a small, JSON-only protocol:

## Authentication

1. `GET /?token=<TOKEN>` returns `303 See Other` + `Set-Cookie:
   dsh-auth-<hash>=v1.<payload>.<sig>; HttpOnly; SameSite=Strict; Path=/`.
2. Every following request (HTTP and WebSocket) must carry that cookie.
   Same-origin browser requests do it automatically; a native/Node client must
   send `Cookie: dsh-auth-...=...`.

## Unary RPC

`POST /api/<endpoint>` (e.g. `/api/session/list`), `content-type: application/json`

Request body:
```json
{"type":"client-request","rpcId":"<uuid>","method":"session/list","payload":{"args":{ ...named args... }}}
```

Success response:
```json
{"type":"server-response","rpcId":"<same uuid>","result":{"ok":true,"value": ...}}
```
Failure response:
```json
{"type":"server-response","rpcId":"<same>","result":{"ok":false,"error":{"code":"...","message":"...","details":{}}}}
```

Named args are the exact host parameter names:
- `session/list`: `{"_request":{}}` (optional `{cursor}`)
- `session/create`: `{"request":{"cwd":"/abs/path"}}` → `{sessionId, agentPreset?}`
- `session/prompt`: `{"request":{"requestId":"<uuid>","sessionId":"session-...","mode":"queue","content":[{"type":"text","text":"..."}],"clientTimeZone":"Asia/Shanghai"}}` → `{accepted:true}`
- `session/cancel`: `{"request":{"sessionId":"session-..."}}`
- `session/page`: `{"request":{"address":{"kind":"session","sessionId":"..."},"throughSeq":<cursor>,"maxMessages":40}}`
- `session/modelCatalog`: `{}` → catalog of providers/models + default
- `session/selectModel`: `{"request":{"sessionId":"...","provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"high"}}`
- `session/rename`: `{"request":{"sessionId":"...","title":"..."}}`

## Streams (multiplexed WebSocket)

`ws(s)://<host>/api/remote.mux`, cookie auth on the handshake.

Open one logical stream:
```json
{"type":"open","streamId":"<uuid>","endpoint":"session/follow","payload":{"args":{"request":{"address":{"kind":"session","sessionId":"session-..."},"maxMessages":40,"assistantStream":true}}}}
```
Server frames:
```json
{"type":"item","streamId":"<uuid>","value":...}
{"type":"error","streamId":"<uuid>","error":{"code":"...","message":"...","details":{}}}
{"type":"end","streamId":"<uuid>"}
```
Cancel: `{"type":"cancel","streamId":"<uuid>"}`.

### `session/follow` item values

1. `{"type":"snapshot","header":{...},"cursor":N,"records":[{"type":"event","event":{...}}],"hasMore":bool,"projections":{...},"assistantStream?":{...}}`
   - `records[].event = {type, seq, time, data, surfaceOp?, ...}`.
   - Snapshot replaces any local transcript state.
2. `{"type":"event","event":{...}}` for each new durable session event.
3. `{"type":"assistant-stream","frame":{...}}` — live model output (process-local).
   frame types: `start`, `chunk`, `end`.
   `chunk.chunk` is a `StreamChunk`:
   - `{type:"text-delta", index, text}`
   - `{type:"reasoning-delta", index, text}`
   - `{type:"tool-call-delta", index, id, name?, argumentsDelta}`
   - `{type:"block-start", index, blockType}`
   - `{type:"block-end", index, block}`
   - `{type:"usage", usage}`, `{type:"finish", reason, replayState?}`
   `end` carries `outcome.kind = committed|abandoned` and the committed seq.

### Durable event types useful for a transcript

- `user/message`: `data.content[]`, `data.source.kind === "user"` for a real
  human prompt; other source kinds (time-context, skills, reminders, runtime
  context) are synthetic and should be hidden in a simple UI.
- `assistant/message`: `data.message.content[]` blocks `text`, `reasoning`,
  `tool-call`, `tool-addition`, `tool-removal`; `data.interrupted` on cancel.
- `assistant/attempt`: attempt that produced no visible message (usually hide).
- `tool/call`: `{callId, name, arguments}` (arguments is a JSON string).
- `tool/result`: `{message:{content[], isError}, error?, meta?}`.
- `turn/start` / `step/start` / `step/end` / `turn/end`: status indicators;
  `turn/end.reason.kind` is `completed`, `cancelled`, `error`, ...
- `session/title`: `{title}` → use for the session title (fallback titles use
  `session/title` with source.kind `fallback`, provider titles update later).
- `approval/asked`, `user-questions` projection: not used by this deployment's
  default `danger-full-access` preset (approval never asked). If the agent
  asks a question, the turn waits for the answer.
- `agent/inbox/spliced`, `request/*`, `system/message`, etc. are internal.

Session summaries from `session/list` already include
`projections.values.title`, `tokenUsage`, `modelSelection`, `permissions`,
`turnOutline`, and `running`, so the list screen needs no extra calls.

## Other useful facts

- `session/list` `items[].sessionId`, `updatedAt`, `cwd`, `running`,
  `agentAvailable`, `blank`, `projections.values.title`.
- New chat: `session/create` with `cwd` (absolute path on the host, e.g.
  `/root/DSH-Client`); then open `session/follow` and send `session/prompt`.
- `session/follow` snapshot is message-aligned for `maxMessages`; for older
  history scroll-up, call `session/page` with `throughSeq = cursor` from the
  opening snapshot and `beforeSeq` of the oldest loaded event, then prepend.
  (A simple client may just request a bigger `maxMessages`.)
- WebSocket is multiplexed: several logical streams share one physical socket.
  Heartbeat pings are protocol-level; browser/Node WS clients answer pongs
  automatically.
- The host prints `dsh web: <url>?token=...` on startup; `~/.dsh/web-url.txt`
  can be stale after IP/host changes or restarts.
