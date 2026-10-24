#!/usr/bin/env node
// Capture REAL wire-protocol fixtures from the live DSH web server.
//
// Creates one tiny throwaway session, follows it over the multiplex WS,
// sends one short prompt, records every frame until the turn commits, then
// records a post-turn snapshot + a session/page response and the error
// envelopes. The output in tools/fixtures/ is what tools/test-transcript.mjs
// replays; no network or LLM access is needed to run the tests.
//
// Usage: node tools/test-capture.mjs [--base http://127.0.0.1:3080]
//                                    [--token-file <path>]
//                                    [--prompt "Reply with exactly: pong."]
//
// LLM cost: exactly one short prompt (plus fallback title generation by the
// host). Never touches the user's live session.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireDsh = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/');
const WebSocket = requireDsh('ws');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const OUT = path.join(HERE, 'fixtures');
const TOKEN_FILE = process.env.DSH_TOKEN_FILE || ((process.env.HOME || '.') + '/.dsh-token');

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const PROMPT = opt('prompt', 'Reply with exactly: pong. Do not use any tools.');
const ERRORS_ONLY = argv.includes('--errors-only');
const CWD = opt('cwd', REPO);
const TZ = opt('tz', 'Asia/Shanghai');

const tokenUrl = new URL(fs.readFileSync(TOKEN_FILE, 'utf8').trim());
const BASE = new URL(opt('base', tokenUrl.origin));
const HOST = BASE.hostname;
const PORT = Number(BASE.port || 80);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function raw(method, pathname, body, cookie) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    if (cookie) headers.cookie = cookie;
    const r = http.request({ host: HOST, port: PORT, path: pathname, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

let COOKIE = '';
async function auth() {
  const res = await raw('GET', '/?token=' + tokenUrl.searchParams.get('token'));
  const set = res.headers['set-cookie'] || [];
  const m = /^(dsh-auth-[^=]+=[^;]+)/.exec(set[0] || '');
  if (!m) throw new Error('auth failed: no cookie (status ' + res.status + ')');
  COOKIE = m[1];
  log('auth ok', COOKIE.slice(0, 20) + '...');
}

async function rpc(method, args) {
  const rpcId = crypto.randomUUID();
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } });
  const res = await raw('POST', '/api/' + method, body, COOKIE);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error('non-JSON rpc response (' + res.status + '): ' + res.body.slice(0, 200));
  }
  return { httpStatus: res.status, envelope: parsed };
}

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 1) + '\n');
  log('saved fixtures/' + name);
}

function openFollow(sessionId, maxMessages) {
  const ws = new WebSocket('ws://' + HOST + ':' + PORT + '/api/remote.mux', { headers: { cookie: COOKIE } });
  const streamId = crypto.randomUUID();
  const frames = [];
  let resolveSnapshot, resolveEnd, rejectAll;
  const snapshotP = new Promise((res, rej) => { resolveSnapshot = res; rejectAll = rej; });
  const endP = new Promise((res) => { resolveEnd = res; });
  ws.on('open', () => {
    log('ws open');
    ws.send(JSON.stringify({
      type: 'open',
      streamId,
      endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages, assistantStream: true } } },
    }));
  });
  ws.on('unexpected-response', (rq, res) => { log('ws rejected', res.statusCode); rejectAll(new Error('ws handshake ' + res.statusCode)); });
  ws.on('error', (e) => { log('ws error', e.message); });
  ws.on('message', (d) => {
    let f;
    try { f = JSON.parse(d.toString()); } catch { return; }
    frames.push({ t: Date.now(), frame: f });
    if (f.type === 'item' && f.value && f.value.type === 'snapshot') resolveSnapshot(f.value);
    if (f.type === 'item' && f.value && f.value.type === 'assistant-stream') {
      if (f.value.frame && f.value.frame.type === 'end') log('assistant-stream end', JSON.stringify(f.value.frame.outcome || f.value.frame));
    }
    if (f.type === 'item' && f.value && f.value.type === 'event' && f.value.event.type === 'turn/end') log('turn/end event', JSON.stringify(f.value.event.data));
    if (f.type === 'end') { resolveEnd(f.value || {}); }
    if (f.type === 'error') log('stream error', JSON.stringify(f.error));
  });
  return { ws, streamId, frames, snapshotP, endP, close: () => { try { ws.send(JSON.stringify({ type: 'cancel', streamId })); } catch {} try { ws.close(); } catch {} } };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await auth();
  if (ERRORS_ONLY) return captureErrors();

  // ---- model catalog ------------------------------------------------------
  {
    const r = await rpc('session/modelCatalog', {});
    save('model-catalog.json', r);
  }

  // ---- session list -------------------------------------------------------
  {
    const r = await rpc('session/list', { _request: {} });
    save('session-list.json', r);
  }

  // ---- fresh test session -------------------------------------------------
  const created = await rpc('session/create', { request: { cwd: CWD } });
  log('create', JSON.stringify(created.envelope.result));
  if (!created.envelope.result || !created.envelope.result.ok) throw new Error('session/create failed: ' + created.envelope.result?.error?.message);
  const sessionId = created.envelope.result.value.sessionId;
  save('session-create.json', created);

  // ---- follow BEFORE prompting: capture empty snapshot + live stream ------
  const follow = openFollow(sessionId, 40);
  const snapshot0 = await Promise.race([follow.snapshotP, sleep(15000).then(() => { throw new Error('no initial snapshot'); })]);
  log('initial snapshot cursor', snapshot0.cursor, 'records', snapshot0.records.length);

  // ---- one tiny prompt ----------------------------------------------------
  const promptReq = {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: PROMPT }],
      clientTimeZone: TZ,
    },
  };
  const prompted = await rpc('session/prompt', promptReq);
  log('prompt', JSON.stringify(prompted.envelope.result));
  if (!prompted.envelope.result?.ok) throw new Error('prompt rejected');

  // Wait for the whole turn: turn/end durable event + assistant-stream end.
  const deadline = Date.now() + 180000;
  let done = false;
  while (!done && Date.now() < deadline) {
    await sleep(250);
    const frames = follow.frames.map((x) => x.frame);
    const turnEnd = frames.some((f) => f.type === 'item' && f.value.type === 'event' && f.value.event.type === 'turn/end');
    const streamEnd = frames.some((f) => f.type === 'item' && f.value.type === 'assistant-stream' && f.value.frame.type === 'end');
    done = turnEnd && streamEnd;
  }
  log('turn complete?', done, 'frames', follow.frames.length);
  await sleep(500);
  follow.close();
  await sleep(300);

  save('follow-live.json', {
    recordedAt: new Date().toISOString(),
    base: BASE.origin,
    sessionId,
    prompt: PROMPT,
    promptRequest: promptReq,
    initialSnapshot: snapshot0,
    frames: follow.frames,
  });

  // ---- re-follow: post-turn snapshot (durable events incl. committed message)
  const follow2 = openFollow(sessionId, 40);
  const snapshot1 = await Promise.race([follow2.snapshotP, sleep(15000).then(() => { throw new Error('no post snapshot'); })]);
  await sleep(300);
  follow2.close();
  await sleep(300);
  save('follow-snapshot.json', {
    recordedAt: new Date().toISOString(),
    base: BASE.origin,
    sessionId,
    snapshot: snapshot1,
    frames: follow2.frames,
  });
  log('post snapshot cursor', snapshot1.cursor, 'records', snapshot1.records.length, 'hasMore', snapshot1.hasMore);

  // ---- session/page (history paging) -------------------------------------
  {
    const beforeSeq = snapshot1.records.length ? snapshot1.records[0].event.seq : undefined;
    const pageReq = { request: { address: { kind: 'session', sessionId }, throughSeq: snapshot1.cursor, maxMessages: 10 } };
    if (beforeSeq != null) pageReq.request.beforeSeq = beforeSeq;
    const r = await rpc('session/page', pageReq);
    save('session-page.json', { request: pageReq, response: r });
  }

  // ---- mark this throwaway session clearly --------------------------------
  {
    const r = await rpc('session/rename', { request: { sessionId, title: '[protocol test] transcript fixture ' + sessionId.slice(-6) } });
    save('session-rename.json', r);
  }

  await captureErrors();
  log('done. session', sessionId);
}

// Error envelopes: bad auth, unknown endpoint, invalid args, unknown session.
async function captureErrors() {
  const badCookie = 'dsh-auth-bogus=bad';
  const unauth = await raw('POST', '/api/session/list', JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session/list', payload: { args: { _request: {} } } }), badCookie);
  const unknownHttp = await raw('POST', '/api/no/suchEndpoint', JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'no/suchEndpoint', payload: { args: {} } }), COOKIE);
  const badArgs = await rpc('session/follow', {});
  const missingSession = await rpc('session/rename', { request: { sessionId: 'session-does-not-exist', title: 'x' } });
  const badJson = await raw('POST', '/api/session/list', '{not json', COOKIE);
  // WS stream-level error envelope (follow a session that does not exist).
  const wsError = await new Promise((resolve) => {
    const frames = [];
    const ws = new WebSocket('ws://' + HOST + ':' + PORT + '/api/remote.mux', { headers: { cookie: COOKIE } });
    const streamId = crypto.randomUUID();
    const finish = (extra) => { try { ws.close(); } catch {} resolve({ streamId, frames, ...extra }); };
    const timer = setTimeout(() => finish({ timedOut: true }), 6000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'open', streamId, endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId: 'session-does-not-exist' }, maxMessages: 5, assistantStream: true } } },
      }));
    });
    ws.on('message', (d) => {
      let f; try { f = JSON.parse(d.toString()); } catch { return; }
      frames.push(f);
      if (f.type === 'error' || f.type === 'end') { clearTimeout(timer); finish({}); }
    });
    ws.on('error', (e) => { clearTimeout(timer); finish({ wsError: e.message }); });
    ws.on('unexpected-response', (rq, res) => { clearTimeout(timer); finish({ handshake: res.statusCode }); });
  });

  // Cancel semantics for a follow stream: does the host answer with an end
  // frame, or is a follow stream cancelled silently?
  const cancelProbe = await new Promise((resolve) => {
    const ws = new WebSocket('ws://' + HOST + ':' + PORT + '/api/remote.mux', { headers: { cookie: COOKIE } });
    const streamId = crypto.randomUUID();
    const out = { streamId, frames: [], endWithinMs: null };
    const started = Date.now();
    const finish = () => { try { ws.close(); } catch {} resolve(out); };
    const timer = setTimeout(finish, 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'open', streamId, endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId: 'session-d267a822-96f8-4133-a6c3-7a9716f64e36' }, maxMessages: 5, assistantStream: true } } },
      }));
    });
    ws.on('message', (d) => {
      let f; try { f = JSON.parse(d.toString()); } catch { return; }
      out.frames.push(f.type);
      if (f.type === 'item' && f.value && f.value.type === 'snapshot') {
        ws.send(JSON.stringify({ type: 'cancel', streamId }));
        out.cancelSentAt = Date.now() - started;
      }
      if (f.type === 'end') { out.endWithinMs = Date.now() - started; clearTimeout(timer); finish(); }
    });
    ws.on('error', finish);
    ws.on('unexpected-response', (rq, res) => { out.handshake = res.statusCode; clearTimeout(timer); finish(); });
  });

  save('errors.json', {
    unauthorized: { httpStatus: unauth.status, body: unauth.body.slice(0, 2000) },
    unknownEndpoint: { httpStatus: unknownHttp.status, body: unknownHttp.body.slice(0, 2000) },
    badArgs,
    missingSession,
    badJson: { httpStatus: badJson.status, body: badJson.body.slice(0, 2000) },
    wsStreamError: wsError,
    followCancel: cancelProbe,
  });
  log('errors captured', unauth.status, unknownHttp.status, badArgs.httpStatus, missingSession.httpStatus, badJson.status);
  if (ERRORS_ONLY) log('errors-only run complete');
}

main().catch((e) => {
  console.error('CAPTURE FAILED:', e && e.stack || e);
  process.exit(1);
});
