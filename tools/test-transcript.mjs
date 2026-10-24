#!/usr/bin/env node
// Offline tests for web/transcript.js and web/api.js using REAL recorded wire
// fixtures (tools/fixtures/*.json, captured by tools/test-capture.mjs from the
// live dsh web server). No network or LLM access needed.
//
// Usage: node tools/test-transcript.mjs [--verbose]

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const FIX = path.join(HERE, 'fixtures');
const requireHere = createRequire(import.meta.url);

const DSHTranscript = requireHere(path.join(REPO, 'web/transcript.js'));
const DSHClient = requireHere(path.join(REPO, 'web/api.js'));

if (!fs.existsSync(FIX)) {
  console.log('SKIP: tools/fixtures/ is absent. Record local fixtures with `node tools/test-capture.mjs <dsh-url>` (they contain live session data and are gitignored).');
  process.exit(0);
}

const VERBOSE = process.argv.includes('--verbose');
let passed = 0;
const failures = [];

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

function eq(actual, expected, what) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
    if (VERBOSE) console.log('  ok', what);
    return;
  }
  throw new Error(what + ': expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
}

function ok(cond, what) {
  if (!cond) throw new Error(what);
  passed += 1;
  if (VERBOSE) console.log('  ok', what);
}

function throwsCode(fn, code, what) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => { throw new Error(what + ': expected error ' + code + ', got success'); },
      (e) => eq(e.code, code, what)
    );
}

function test(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.then(
      () => console.log('PASS', name),
      (e) => { failures.push(name + ': ' + e.message); console.log('FAIL', name, '-', e.message); }
    );
    console.log('PASS', name);
    return Promise.resolve();
  } catch (e) {
    failures.push(name + ': ' + e.message);
    console.log('FAIL', name, '-', e.message);
    return Promise.resolve();
  }
}

const live = fixture('follow-live.json');
const snap = fixture('follow-snapshot.json');
const catalog = fixture('model-catalog.json');
const list = fixture('session-list.json');
const errors = fixture('errors.json');

const byKind = (t) => t.items.reduce((acc, it) => {
  (acc[it.kind] = acc[it.kind] || []).push(it);
  return acc;
}, {});

// ---------------------------------------------------------------------------
// 1. Post-turn snapshot baseline
// ---------------------------------------------------------------------------
await test('snapshot baseline: title/items/hide synthetic users', () => {
  const t = new DSHTranscript();
  t.reset(snap.snapshot);
  eq(t.title, 'Ping request response test', 'title from last session/title');
  const kinds = t.items.map((i) => i.kind);
  eq(kinds, ['user', 'assistant'], 'snapshot item kinds');
  eq(t.items[0].text, live.prompt, 'user prompt text');
  eq(t.items[1].text, 'pong', 'assistant text from durable message');
  eq(t.items[1].streaming, false, 'durable assistant not streaming');
  eq(t.items[1].seq, 18, 'assistant seq');
  eq(t.running, false, 'not running after turn/end');
  eq(t.cursor, 21, 'cursor from snapshot');
  eq(t.hasMore, false, 'hasMore');
  eq(t.lastSeq, 21, 'lastSeq tracks cursor');
  // synthetic user/message events (runtime-context, skill-catalog, time-context)
  eq(live.initialSnapshot.records.map((r) => r.event.type), ['permission/preset', 'sandbox/mode', 'approval/policy'], 'opening snapshot records');
});

// ---------------------------------------------------------------------------
// 2. Live follow replay: snapshot -> events + assistant-stream -> commit
// ---------------------------------------------------------------------------
await test('live replay: streamed text then committed message (same item, no duplicate)', () => {
  const t = new DSHTranscript();
  t.reset(live.initialSnapshot);
  eq(t.items.length, 0, 'empty initial transcript');
  eq(t.running, false, 'initially not running');

  let sawStreamingWithText = false;
  let sawStreaming = false;
  const ids = [];
  for (const { frame } of live.frames) {
    if (frame.type !== 'item') continue;
    const v = frame.value;
    if (v.type === 'event') {
      t.applyEvent(v);
    } else if (v.type === 'assistant-stream') {
      t.applyAssistantFrame(v);
      if (v.frame.type === 'start') ids.push(t.streamingItem && t.streamingItem.id);
      if (v.frame.type === 'chunk' && t.streamingItem) {
        sawStreaming = true;
        if (t.streamingItem.text.length > 0) sawStreamingWithText = true;
      }
      if (v.frame.type === 'end') t.applyStreamEnd(v);
    }
  }
  ok(sawStreaming, 'assistant stream produced a streaming item');
  ok(sawStreamingWithText, 'streaming item text grew from text-delta chunks');
  const kinds = byKind(t);
  eq(kinds.user.length, 1, 'one human user item');
  eq(kinds.assistant.length, 1, 'exactly one assistant item (no duplicate)');
  const a = kinds.assistant[0];
  eq(a.text, 'pong', 'committed assistant text');
  eq(a.streaming, false, 'assistant finalized');
  eq(a.seq, 18, 'promoted to durable seq');
  ok(ids[0] === a.id, 'live item id kept stable through commit (' + ids[0] + ')');
  eq(t.title, 'Ping request response test', 'provider title replaced fallback title');
  eq(t.running, false, 'running cleared by turn/end');
  eq(t.items.length, 2, 'no notices for a completed turn');
  eq(t.lastSeq, 21, 'lastSeq at end of turn');
});

// ---------------------------------------------------------------------------
// 3. Snapshot assistant-stream baseline (late follow while streaming)
// ---------------------------------------------------------------------------
await test('snapshot assistantStream.activeAttempt replay + revision dedupe', () => {
  const t = new DSHTranscript();
  const activeSnapshot = {
    type: 'snapshot',
    header: { version: 4, id: 'session-test', cwd: '/root/DSH-Client' },
    cursor: 10,
    hasMore: false,
    projections: { values: { title: 'live session' } },
    records: [
      { type: 'event', event: { type: 'turn/start', seq: 2, time: 1, data: { turn: 1 } } },
      { type: 'event', event: { type: 'step/start', seq: 3, time: 2, data: { turn: 1, step: 1 } } },
      { type: 'event', event: { type: 'user/message', seq: 4, time: 3, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } } },
    ],
    assistantStream: {
      revision: 5,
      activeAttempt: {
        attemptId: 'session-test:1',
        startedAfterSeq: 10,
        turn: 1,
        step: 1,
        nextIndex: 4,
        stream: [
          { type: 'chunk', time: 11, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'text-chunks', time0: 12, index: 0, dt: [1], texts: ['Hel', 'lo'] },
          { type: 'chunk', time: 13, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } } },
        ],
      },
    },
  };
  t.reset(activeSnapshot);
  eq(t.title, 'live session', 'title from projections');
  eq(t.items.length, 2, 'user + live assistant');
  eq(t.streamingItem.text, 'Hello', 'replayed partial text');
  eq(t.streamingItem.streaming, true, 'assistant streaming after snapshot');

  // Replayed frames at/below baseline revision must be ignored.
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'session-test:1', revision: 5, index: 0, time: 14, chunk: { type: 'text-delta', index: 0, text: 'NOPE' } } });
  eq(t.streamingItem.text, 'Hello', 'replayed chunk ignored');
  // Cursorless live continuation.
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'session-test:1', revision: 6, index: 4, time: 15, chunk: { type: 'text-delta', index: 0, text: ' world' } } });
  eq(t.streamingItem.text, 'Hello world', 'live continuation applied');
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'session-test:1', revision: 7, index: 5, time: 16, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } } } });
  eq(t.streamingItem.text, 'Hello world', 'block-end authoritative text');
  t.applyStreamEnd({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'session-test:1', revision: 8, index: 6, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 11 } } });
  t.applyEvent({ type: 'event', event: { type: 'assistant/message', seq: 11, time: 17, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] } } } });
  eq(t.items.length, 2, 'no duplicate assistant item after commit');
  const a = byKind(t).assistant[0];
  eq(a.id, 'a-session-test:1', 'stable live id');
  eq(a.streaming, false, 'finalized');
  eq(a.seq, 11, 'seq attached');
});

// ---------------------------------------------------------------------------
// 4. Tool call/result pairing from durable events
// ---------------------------------------------------------------------------
await test('tool/call + tool/result merge into one card with status transitions', () => {
  const t = new DSHTranscript();
  t.reset(emptySnapshot());
  t.applyEvent({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } });
  t.applyEvent({
    type: 'event', event: { type: 'assistant/message', seq: 2, time: 2, data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool-call', id: 'call_abc', name: 'bash', arguments: '{"command":"ls"}' },
      ] },
    } },
  });
  t.applyEvent({ type: 'event', event: { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 1, callId: 'call_abc', name: 'bash', arguments: '{"command":"ls"}' } } });
  t.applyEvent({ type: 'event', event: { type: 'tool/result', seq: 4, time: 4, data: {
    turn: 1, step: 1,
    message: { role: 'tool', source: { kind: 'tool', callId: 'call_abc' }, toolCallId: 'call_abc', content: [{ type: 'text', text: 'a.txt' }], isError: false },
  } } });
  const tools = byKind(t).tool || [];
  eq(tools.length, 1, 'single tool card (no duplicate from assistant content + tool/call)');
  eq(tools[0].callId, 'call_abc', 'callId');
  eq(tools[0].name, 'bash', 'name');
  eq(tools[0].argsText, '{"command":"ls"}', 'argsText');
  eq(tools[0].status, 'ok', 'status ok');
  eq(tools[0].resultText, 'a.txt', 'resultText');
  const kinds = t.items.map((i) => i.kind);
  eq(kinds, ['assistant', 'tool'], 'assistant then tool card ordering');
  t.applyEvent({ type: 'event', event: { type: 'tool/result', seq: 5, time: 5, data: {
    turn: 1, step: 1,
    message: { role: 'tool', toolCallId: 'call_abc', content: [{ type: 'text', text: 'boom' }], isError: true },
  } } });
  eq(t.items.filter((i) => i.kind === 'tool').length, 1, 'duplicate result updates, never adds');
  eq(byKind(t).tool[0].status, 'error', 'status error from isError');
  eq(byKind(t).tool[0].resultText, 'boom', 'error output');
});

// ---------------------------------------------------------------------------
// 5. Live tool-call deltas -> durable commit
// ---------------------------------------------------------------------------
await test('live tool-call deltas create provisional card, durable events complete it', () => {
  const t = new DSHTranscript();
  t.reset(emptySnapshot());
  const attempt = 's:1';
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'start', attemptId: attempt, revision: 1, startedAfterSeq: 0, turn: 1, step: 1 } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: attempt, revision: 2, index: 0, time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: attempt, revision: 3, index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: 'Running it.' } } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: attempt, revision: 4, index: 2, time: 3, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: attempt, revision: 5, index: 3, time: 4, chunk: { type: 'tool-call-delta', index: 1, id: 'call_x', name: 'bash', argumentsDelta: '{"command":' } } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: attempt, revision: 6, index: 4, time: 5, chunk: { type: 'tool-call-delta', index: 1, id: 'call_x', name: 'bash', argumentsDelta: '"echo hi"}' } } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: attempt, revision: 7, index: 5, time: 6, chunk: { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_x', name: 'bash', arguments: '{"command":"echo hi"}' } } } });
  const provisional = byKind(t).tool || [];
  eq(provisional.length, 1, 'provisional tool card during stream');
  eq(provisional[0].status, 'running', 'provisional card running');
  eq(provisional[0].argsText, '{"command":"echo hi"}', 'argsText completed at block-end');
  eq(t.streamingItem.text, 'Running it.', 'assistant text while tool runs');

  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: attempt, revision: 8, index: 6, time: 7, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } } });
  t.applyStreamEnd({ type: 'assistant-stream', frame: { type: 'end', attemptId: attempt, revision: 9, index: 7, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 20 } } });
  t.applyEvent({ type: 'event', event: { type: 'assistant/message', seq: 20, time: 8, data: {
    turn: 1, step: 1,
    message: { role: 'assistant', content: [
      { type: 'text', text: 'Running it.' },
      { type: 'tool-call', id: 'call_x', name: 'bash', arguments: '{"command":"echo hi"}' },
    ] },
  } } });
  t.applyEvent({ type: 'event', event: { type: 'tool/call', seq: 21, time: 9, data: { turn: 1, step: 1, callId: 'call_x', name: 'bash', arguments: '{"command":"echo hi"}' } } });
  t.applyEvent({ type: 'event', event: { type: 'tool/result', seq: 22, time: 10, data: {
    turn: 1, step: 1,
    message: { role: 'tool', toolCallId: 'call_x', content: [{ type: 'text', text: 'hi' }], isError: false },
  } } });
  const kinds = t.items.reduce((acc, i) => { acc[i.kind] = (acc[i.kind] || 0) + 1; return acc; }, {});
  eq(kinds.assistant, 1, 'one assistant item');
  eq(kinds.tool, 1, 'one tool item');
  eq(byKind(t).tool[0].status, 'ok', 'tool ok after result');
  eq(byKind(t).assistant[0].text, 'Running it.', 'assistant text after commit');
  eq(byKind(t).assistant[0].id, 'a-' + attempt, 'assistant id stable');
});

// ---------------------------------------------------------------------------
// 6. Cancelled / interrupted
// ---------------------------------------------------------------------------
await test('abandoned stream + aborted turn marks interrupted and adds a warning notice', () => {
  const t = new DSHTranscript();
  t.reset(emptySnapshot());
  t.applyEvent({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } });
  t.applyEvent({ type: 'event', event: { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'long task' }], source: { kind: 'user' } } } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'start', attemptId: 's:1', revision: 1, startedAfterSeq: 2, turn: 1, step: 1 } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 's:1', revision: 2, index: 0, time: 3, chunk: { type: 'block-start', index: 0, blockType: 'text' } } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 's:1', revision: 3, index: 1, time: 4, chunk: { type: 'text-delta', index: 0, text: 'Partial' } } });
  t.applyStreamEnd({ type: 'assistant-stream', frame: { type: 'end', attemptId: 's:1', revision: 4, index: 2, outcome: { kind: 'abandoned' } } });
  const a = byKind(t).assistant[0];
  eq(a.interrupted, true, 'assistant marked interrupted');
  eq(a.streaming, false, 'assistant not streaming');
  eq(t.running, true, 'turn still open');
  t.applyEvent({ type: 'event', event: { type: 'turn/end', seq: 3, time: 5, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } } });
  eq(t.running, false, 'running false after aborted turn');
  const notices = byKind(t).notice || [];
  eq(notices.length, 1, 'one notice');
  eq(notices[0].tone, 'warn', 'warn tone');
  eq(notices[0].text, 'Stopped.', 'stopped text');
});

await test('interrupted assistant/message flag + durable partial text', () => {
  const t = new DSHTranscript();
  t.reset(emptySnapshot());
  t.applyEvent({ type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } });
  t.applyEvent({ type: 'event', event: { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } } } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'start', attemptId: 's:1', revision: 1, startedAfterSeq: 2, turn: 1, step: 1 } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 's:1', revision: 2, index: 0, time: 3, chunk: { type: 'block-start', index: 0, blockType: 'text' } } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 's:1', revision: 3, index: 1, time: 4, chunk: { type: 'text-delta', index: 0, text: 'half' } } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 's:1', revision: 4, index: 2, time: 5, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'half' } } } });
  t.applyStreamEnd({ type: 'assistant-stream', frame: { type: 'end', attemptId: 's:1', revision: 5, index: 3, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } } });
  t.applyEvent({ type: 'event', event: { type: 'assistant/message', seq: 9, time: 6, data: {
    turn: 1, step: 1, interrupted: true,
    message: { role: 'assistant', content: [{ type: 'text', text: 'half' }] },
  } } });
  const a = byKind(t).assistant[0];
  eq(a.text, 'half', 'partial durable text');
  eq(a.interrupted, true, 'interrupted flag from durable event');
  eq(byKind(t).assistant.length, 1, 'one assistant item');
  eq(byKind(t).notice.length, 1, 'interrupted notice');
});

// ---------------------------------------------------------------------------
// 7. Unknown/internal events are ignored safely
// ---------------------------------------------------------------------------
await test('transport end envelope is a no-op for an active stream', () => {
  const t = new DSHTranscript();
  t.reset(emptySnapshot());
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'start', attemptId: 's:9', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 's:9', revision: 2, index: 0, time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } });
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 's:9', revision: 3, index: 1, time: 2, chunk: { type: 'text-delta', index: 0, text: 'still' } } });
  t.applyStreamEnd({ type: 'end', streamId: 'whatever' });
  eq(t.streamingItem.streaming, true, 'stream still streaming after transport end');
  eq(t.streamingItem.interrupted, undefined, 'not marked interrupted');
  eq(t.streamingItem.text, 'still', 'text preserved');
});

await test('unknown and internal events are ignored', () => {
  const t = new DSHTranscript();
  t.reset(snap.snapshot);
  const before = JSON.stringify(t.items);
  const seqs = [100, 101, 102, 103];
  const types = ['some/unknown', 'system/message', 'agent/inbox/spliced', 'request/header'];
  types.forEach((type, i) => t.applyEvent({ type: 'event', event: { type, seq: seqs[i], time: 1, data: { turn: 1, step: 1, message: { content: [] } } } }));
  t.applyAssistantFrame({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'nope', revision: 99, index: 0, time: 1, chunk: { type: 'some-new-chunk', x: 1 } } });
  eq(JSON.stringify(t.items), before, 'rendered items unchanged');
  eq(t.running, false, 'running unchanged');
});

// ---------------------------------------------------------------------------
// 8. History paging (prepend)
// ---------------------------------------------------------------------------
await test('pageOlder prepend keeps order, pairs tools, dedupes, updates hasMore', () => {
  const t = new DSHTranscript();
  t.reset({
    type: 'snapshot',
    header: { id: 's' },
    cursor: 20,
    hasMore: true,
    projections: { values: { title: 't' } },
    records: [
      { type: 'event', event: { type: 'user/message', seq: 18, time: 1, data: { content: [{ type: 'text', text: 'newer q' }], source: { kind: 'user' } } } },
      { type: 'event', event: { type: 'assistant/message', seq: 19, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'newer a' }] } } } },
    ],
  });
  eq(t.hasMore, true, 'hasMore initially true');
  const older = [
    { type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'older q' }], source: { kind: 'user' } } } },
    { type: 'event', event: { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'older a' }] } } } },
    { type: 'event', event: { type: 'tool/call', seq: 3, time: 3, data: { turn: 1, step: 1, callId: 'call_old', name: 'bash', arguments: '{"command":"pwd"}' } } },
    { type: 'event', event: { type: 'tool/result', seq: 4, time: 4, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_old', content: [{ type: 'text', text: '/root' }], isError: false } } } },
  ];
  t.prependRecords(older, false);
  eq(t.items.map((i) => i.kind), ['user', 'assistant', 'tool', 'user', 'assistant'], 'prepended before existing');
  eq(t.items[0].text, 'older q', 'oldest first');
  eq(t.items[2].status, 'ok', 'tool paired across prepend batch');
  eq(t.items[2].resultText, '/root', 'tool result text');
  eq(t.hasMore, false, 'hasMore updated');
  eq(t.cursor, 20, 'cursor unchanged');
  t.prependRecords(older, false);
  eq(t.items.length, 5, 'duplicate prepend is a no-op');
});

await test('pageOlder prepend pairs a tool/call with a result already in the snapshot', () => {
  const t = new DSHTranscript();
  t.reset({
    type: 'snapshot',
    header: { id: 's' },
    cursor: 30,
    hasMore: true,
    projections: { values: {} },
    records: [
      { type: 'event', event: { type: 'tool/result', seq: 30, time: 2, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_split', content: [{ type: 'text', text: 'ok' }], isError: false } } } },
    ],
  });
  eq(t.items.length, 1, 'orphan result created its card');
  eq(t.items[0].name, 'tool', 'placeholder name until call arrives');
  t.prependRecords([
    { type: 'event', event: { type: 'tool/call', seq: 29, time: 1, data: { turn: 1, step: 1, callId: 'call_split', name: 'bash', arguments: '{"command":"date"}' } } },
  ], true);
  eq(t.items.length, 1, 'still one merged tool card');
  eq(t.items[0].name, 'bash', 'name filled in from paged call');
  eq(t.items[0].argsText, '{"command":"date"}', 'args filled in');
  eq(t.items[0].status, 'ok', 'status preserved');
  eq(t.hasMore, true, 'hasMore true');
});

// ---------------------------------------------------------------------------
// 9. api.js offline unit tests (fake fetch): envelopes + frame routing
// ---------------------------------------------------------------------------
await test('api.js unary envelope handling: ok / rpc error / 401 auth error', async () => {
  const seen = { auth: 0, err: 0 };
  function fakeFetch(status, body) {
    return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
  }
  const okClient = new DSHClient({ baseUrl: 'http://127.0.0.1:3080', fetchImpl: fakeFetch(200, JSON.stringify({
    type: 'server-response', rpcId: 'r', result: { ok: true, value: { items: [{ sessionId: 's1' }] } },
  })) });
  const items = await okClient.listSessions();
  eq(items.length, 1, 'listSessions unwraps result.value.items');
  eq(items[0].sessionId, 's1', 'item passthrough');

  const errClient = new DSHClient({ baseUrl: 'http://127.0.0.1:3080', fetchImpl: fakeFetch(200, JSON.stringify({
    type: 'server-response', rpcId: 'r', result: { ok: false, error: { code: 'session/not-found', message: 'nope', details: { sessionId: 'x' } } },
  })) });
  await throwsCode(() => errClient.renameSession('x', 't'), 'session/not-found', 'rpc error code surfaced');

  const authClient = new DSHClient({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: fakeFetch(401, 'unauthorized'),
    onAuthError: () => { seen.auth += 1; },
    onError: () => { seen.err += 1; },
  });
  await throwsCode(() => authClient.listSessions(), 'unauthorized', '401 surfaces unauthorized');
  eq(seen.auth, 1, 'onAuthError called once');
  eq(authClient.status, 'offline', 'status offline after auth error');
});

await test('api.js stream frame routing to callbacks', () => {
  const calls = { snapshots: 0, events: 0, frames: 0, ends: 0 };
  const client = new DSHClient({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: () => Promise.reject(new Error('unused')),
    onSnapshot: () => { calls.snapshots += 1; },
    onEvent: () => { calls.events += 1; },
    onAssistantFrame: () => { calls.frames += 1; },
    onStreamEnd: () => { calls.ends += 1; },
  });
  client._streams = { s1: { kind: 'follow', sessionId: 's' } };
  client._handleFrame(JSON.stringify({ type: 'item', streamId: 's1', value: { type: 'snapshot', cursor: 0, records: [] } }));
  client._handleFrame(JSON.stringify({ type: 'item', streamId: 's1', value: { type: 'event', event: { type: 'turn/start', seq: 1, data: { turn: 1 } } } }));
  client._handleFrame(JSON.stringify({ type: 'item', streamId: 's1', value: { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1, startedAfterSeq: 1 } } }));
  client._handleFrame(JSON.stringify({ type: 'item', streamId: 's1', value: { type: 'assistant-stream', frame: { type: 'end', attemptId: 'a', revision: 2, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } } } }));
  client._handleFrame(JSON.stringify({ type: 'end', streamId: 's1' }));
  eq(calls.snapshots, 1, 'onSnapshot');
  eq(calls.events, 1, 'onEvent');
  eq(calls.frames, 2, 'onAssistantFrame for start + end');
  eq(calls.ends, 2, 'onStreamEnd for stream end frame + transport end');
});

await test('api.js stream error frame surfaces code/details via onError', () => {
  const got = [];
  const client = new DSHClient({
    baseUrl: 'http://127.0.0.1:3080',
    fetchImpl: () => Promise.reject(new Error('unused')),
    onError: (e) => got.push(e),
  });
  client._streams = { s9: { kind: 'follow', sessionId: 'session-does-not-exist' } };
  client._handleFrame(JSON.stringify(errors.wsStreamError.frames[0]));
  eq(got.length, 1, 'onError called for WS error frame');
  eq(got[0].code, 'session/not-found', 'error code surfaced');
  eq(got[0].details.sessionId, 'session-does-not-exist', 'error details surfaced');
  eq(client._streamKind('s9'), 'follow', 'stream stays registered for teardown');
});

// ---------------------------------------------------------------------------
// 10. Fixture sanity: shapes captured from the real host
// ---------------------------------------------------------------------------
await test('captured fixtures match the verified protocol shapes', () => {
  ok(Array.isArray(catalog.envelope.result.value.groups), 'model catalog groups');
  ok(catalog.envelope.result.value.default !== undefined, 'model catalog default');
  ok(Array.isArray(list.envelope.result.value.items) && list.envelope.result.value.items.length > 0, 'session list items');
  ok(list.envelope.result.value.items.every((it) => typeof it.sessionId === 'string' && typeof it.updatedAt === 'number'), 'session list item fields');
  eq(errors.unauthorized.httpStatus, 401, '401 for bad cookie is plain-text HTTP');
  eq(errors.unknownEndpoint.httpStatus, 404, '404 for unknown endpoint path');
  eq(errors.badArgs.envelope.result.error.code, 'gateway/arguments-invalid', 'bad args error envelope');
  eq(errors.missingSession.envelope.result.error.code, 'session/not-found', 'missing session error code');
  eq(errors.wsStreamError.frames[0].type, 'error', 'WS error frame envelope type');
  eq(errors.wsStreamError.frames[0].error.code, 'session/not-found', 'WS error frame code');
  eq(errors.followCancel.endWithinMs, null, 'host sends no end frame on follow cancel (fire-and-forget)');

  const liveFrames = live.frames.map((f) => f.frame);
  ok(liveFrames.some((f) => f.type === 'item' && f.value.type === 'assistant-stream' && f.value.frame.type === 'start'), 'fixture has stream start');
  ok(liveFrames.some((f) => f.type === 'item' && f.value.type === 'assistant-stream' && f.value.frame.type === 'end'), 'fixture has stream end');
  ok(liveFrames.some((f) => f.type === 'item' && f.value.type === 'event' && f.value.event.type === 'assistant/message'), 'fixture has committed assistant/message');
});

function emptySnapshot(overrides) {
  return Object.assign({ type: 'snapshot', header: { id: 's' }, cursor: 0, hasMore: false, projections: { values: {} }, records: [] }, overrides || {});
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log('FAILED ' + failures.length + ' test(s), ' + passed + ' assertions passed');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('PASS all tests (' + passed + ' assertions)');
