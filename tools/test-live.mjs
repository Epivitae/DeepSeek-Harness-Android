#!/usr/bin/env node
// Live integration check for web/api.js through the dev proxy (or any origin
// that already carries DSH auth). Verifies:
//   - unary session/list
//   - multiplex WS connect + session/follow snapshot
//   - transcript reducer over the real snapshot
//   - session/page (history paging) round-trip
//   - clean unfollow/close (no hang)
//
// Usage:
//   node tools/dev-proxy.mjs &            # proxy on 127.0.0.1:8099
//   node tools/test-live.mjs              # or --base http://127.0.0.1:8099
//
// The test is read-only: it follows a recorded throwaway test session
// (fixtures/follow-snapshot.json) and never prompts or mutates anything.
// Exits 0 with "SKIP" when the proxy/server is not reachable.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireHere = createRequire(import.meta.url);
const requireDsh = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/');
const WebSocket = requireDsh('ws');

const DSHClient = requireHere(path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/api.js'));
const DSHTranscript = requireHere(path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/transcript.js'));

const argv = process.argv.slice(2);
function opt(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const BASE = opt('base', process.env.DEV_PROXY_BASE || 'http://127.0.0.1:8099');

const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/follow-snapshot.json'), 'utf8'));
const SESSION_ID = opt('session', fixture.sessionId);

let passed = 0;
function eq(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(what + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
  passed += 1;
  console.log('  ok', what);
}
function ok(cond, what) {
  if (!cond) throw new Error(what);
  passed += 1;
  console.log('  ok', what);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('live test against', BASE, 'session', SESSION_ID);
  const statuses = [];
  const errors = [];
  let authErrors = 0;
  let snapshot = null;
  let eventCount = 0;
  let frameCount = 0;

  const client = new DSHClient({
    baseUrl: BASE,
    WebSocketImpl: WebSocket,
    onSnapshot: (value) => { snapshot = value; },
    onEvent: () => { eventCount += 1; },
    onAssistantFrame: () => { frameCount += 1; },
    onStreamEnd: () => {},
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
    onAuthError: () => { authErrors += 1; },
  });

  // ---- connect -----------------------------------------------------------
  const connectTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout')), 10000));
  try {
    await Promise.race([client.connect(), connectTimeout]);
  } catch (e) {
    if (/ECONNREFUSED|fetch failed|connect timeout|network/i.test(String(e && e.message))) {
      console.log('SKIP: dev proxy not reachable at ' + BASE + ' (start `node tools/dev-proxy.mjs`)');
      process.exit(0);
    }
    throw e;
  }
  eq(client.status, 'connected', 'status connected');
  ok(statuses.indexOf('connecting') >= 0, 'status went through connecting');

  // ---- session/list ------------------------------------------------------
  const sessions = await client.listSessions();
  ok(Array.isArray(sessions) && sessions.length > 0, 'session/list returned ' + sessions.length + ' sessions');
  ok(sessions.every((s) => typeof s.sessionId === 'string' && typeof s.updatedAt === 'number'), 'session summaries have sessionId+updatedAt');
  ok(sessions.every((s) => typeof s.sessionId === 'string' && s.sessionId.length > 0), 'list shape sane');

  // ---- follow (snapshot over multiplexed WS) -----------------------------
  const followTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('follow timeout')), 15000));
  await Promise.race([client.follow(SESSION_ID, { maxMessages: 40 }), followTimeout]);
  ok(snapshot && snapshot.type === 'snapshot', 'follow delivered a snapshot');
  ok(typeof snapshot.cursor === 'number', 'snapshot.cursor is a number');
  ok(Array.isArray(snapshot.records) && snapshot.records.length > 0, 'snapshot has durable records');
  eq(client.sessionId, SESSION_ID, 'client.sessionId tracks follow');
  eq(client.isFollowing, true, 'client.isFollowing true');

  const t = new DSHTranscript();
  t.reset(snapshot);
  const kinds = t.items.map((i) => i.kind);
  ok(kinds.indexOf('user') >= 0, 'transcript shows the human prompt');
  ok(kinds.indexOf('assistant') >= 0, 'transcript shows the assistant reply');
  ok(t.title && t.title.length > 0, 'transcript title: ' + JSON.stringify(t.title));
  ok(!t.running, 'recorded session is not running');

  // ---- reconnect + automatic re-follow -----------------------------------
  const snapshots = [snapshot];
  client.onSnapshot = (value) => { snapshots.push(value); };
  const expected = snapshots.length + 1;
  client._ws.close(); // simulate a dropped connection / app backgrounded
  const reconnectDeadline = Date.now() + 25000;
  while (snapshots.length < expected && Date.now() < reconnectDeadline) await sleep(100);
  ok(snapshots.length >= expected, 'reconnect re-follow delivered a fresh snapshot');
  eq(snapshots[snapshots.length - 1].type, 'snapshot', 'post-reconnect snapshot type');
  ok(statuses.indexOf('reconnecting') >= 0, 'status passed through reconnecting');
  eq(client.status, 'connected', 'status connected after reconnect');
  const freshSnapshot = snapshots[snapshots.length - 1];
  const t2 = new DSHTranscript();
  t2.reset(freshSnapshot);
  ok(t2.items.some((i) => i.kind === 'assistant'), 'transcript rebuilt from re-follow snapshot');

  // ---- session/page (paging older history) -------------------------------
  const firstSeq = snapshot.records[0].event ? snapshot.records[0].event.seq : snapshot.records[0].seq;
  const page = await client.pageOlder(SESSION_ID, { throughSeq: snapshot.cursor, beforeSeq: firstSeq, maxMessages: 10 });
  ok(Array.isArray(page.records), 'session/page returns records[]');
  ok(typeof page.hasMore === 'boolean', 'session/page returns hasMore');
  const before = t.items.length;
  t.prependRecords(page.records, page.hasMore);
  eq(t.items.length, before + page.records.filter((r) => r.event && (r.event.type === 'user/message' || r.event.type === 'assistant/message')).length, 'prependRecords adds older messages');

  // ---- clean teardown ----------------------------------------------------
  await client.unfollow();
  eq(client.isFollowing, false, 'unfollow clears isFollowing');
  await sleep(200);
  client.close();
  eq(client.status, 'offline', 'close sets status offline');
  eq(authErrors, 0, 'no auth errors');
  eq(errors.length, 0, 'no transport/stream errors: ' + errors.map((e) => e.message).join('; '));

  console.log('\nPASS live integration (' + passed + ' checks)');
  process.exit(0);
}

const hardTimeout = setTimeout(() => {
  console.log('FAIL: live test exceeded 45s (unfollow/close did not settle?)');
  process.exit(1);
}, 45000);
if (hardTimeout.unref) hardTimeout.unref();

main().catch((e) => {
  console.log('FAIL', e && e.stack || e);
  process.exit(1);
});
