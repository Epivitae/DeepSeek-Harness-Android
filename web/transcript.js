/*!
 * DSHTranscript — reducer from DSH session/follow frames to a flat, stable
 * timeline for rendering. Classic script (Android WebView 91 compatible).
 *
 *   var t = new DSHTranscript();
 *   t.reset(snapshotValue);              // session/follow snapshot item value
 *   t.applyEvent(eventValue);            // {type:'event', event:{...}}
 *   t.applyAssistantFrame(frameValue);   // {type:'assistant-stream', frame:{...}}
 *   t.applyStreamEnd(frameValue);        // {type:'assistant-stream', frame:{type:'end',...}}
 *   t.prependRecords(records, hasMore);  // session/page result (older history)
 *   t.items / t.title / t.running / t.cursor / t.hasMore
 *
 * Item shapes (stable ids across live stream -> committed durable event):
 *   { id, kind:'user', text, seq, time? }
 *   { id, kind:'assistant', reasoning, text, blocks:[{type,text}],
 *     streaming:boolean, interrupted?:boolean, attemptId?, seq?, time? }
 *   { id, kind:'tool', callId, name, argsText, status:'running'|'ok'|'error',
 *     resultText, seq?, time? }
 *   { id, kind:'notice', tone:'info'|'warn'|'error', text, seq? }
 */
(function (root) {
  'use strict';

  function DSHTranscript() {
    this._items = [];
    this._byId = new Map();
    this._byCallId = new Map();
    this._title = null;
    this._running = false;
    this._cursor = 0;
    this._hasMore = false;
    this._lastSeq = -1;
    this._header = null;
    this._turn = 0;
    this._stream = null; // {attemptId, item, expectedIndex, pendingCommitSeq, blocks, usage, finish}
    this._lastLive = null; // last live assistant item awaiting/pending durable promotion
    this._baselineRevision = 0;
    this._prepend = false;
    this._noticeKeys = new Map();
  }

  // -------------------------------------------------------------------------
  // Item helpers
  // -------------------------------------------------------------------------

  DSHTranscript.prototype._append = function (item) {
    this._items.push(item);
    this._byId.set(item.id, item);
    return item;
  };

  DSHTranscript.prototype._remove = function (item) {
    var idx = this._items.indexOf(item);
    if (idx >= 0) this._items.splice(idx, 1);
    this._byId.delete(item.id);
  };

  DSHTranscript.prototype._has = function (id) {
    return this._byId.has(id);
  };

  function textOfContent(content) {
    if (!content || !content.length) return '';
    var out = [];
    for (var i = 0; i < content.length; i += 1) {
      var b = content[i];
      if (b && b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    }
    return out.join('');
  }

  function visibleBlocks(content) {
    var blocks = [];
    if (!content) return blocks;
    for (var i = 0; i < content.length; i += 1) {
      var b = content[i];
      if (!b || typeof b !== 'object') continue;
      if ((b.type === 'text' || b.type === 'reasoning') && typeof b.text === 'string' && b.text.length > 0) {
        blocks.push({ type: b.type, text: b.text });
      }
    }
    return blocks;
  }

  function blocksText(blocks) {
    var out = '';
    for (var i = 0; i < blocks.length; i += 1) if (blocks[i].type === 'text') out += blocks[i].text;
    return out;
  }
  function blocksReasoning(blocks) {
    var out = '';
    for (var i = 0; i < blocks.length; i += 1) if (blocks[i].type === 'reasoning') out += blocks[i].text;
    return out;
  }

  // -------------------------------------------------------------------------
  // Snapshot reset
  // -------------------------------------------------------------------------

  DSHTranscript.prototype.reset = function (snapshot) {
    if (snapshot && snapshot.snapshot && snapshot.type !== 'snapshot') snapshot = snapshot.snapshot;
    this._items = [];
    this._byId = new Map();
    this._byCallId = new Map();
    this._noticeKeys = new Map();
    this._title = null;
    this._running = false;
    this._cursor = 0;
    this._hasMore = false;
    this._lastSeq = -1;
    this._header = null;
    this._turn = 0;
    this._stream = null;
    this._lastLive = null;
    this._baselineRevision = 0;
    this._prepend = false;
    if (!snapshot || snapshot.type !== 'snapshot') return;

    this._header = snapshot.header || null;
    this._cursor = typeof snapshot.cursor === 'number' ? snapshot.cursor : 0;
    this._hasMore = !!snapshot.hasMore;
    var projections = snapshot.projections || null;
    if (projections && projections.values && typeof projections.values.title === 'string') {
      this._title = projections.values.title;
    }

    var records = snapshot.records || [];
    for (var i = 0; i < records.length; i += 1) {
      var ev = records[i] && records[i].event ? records[i].event : records[i];
      if (ev && ev.type) this._applyEventTo(ev, this._items);
    }
    if (this._lastSeq < this._cursor) this._lastSeq = this._cursor;

    // Live in-progress assistant attempt replayed in the opening snapshot:
    // rebuild the partial message so the stream can continue from nextIndex.
    var assistantStream = snapshot.assistantStream || null;
    this._baselineRevision = assistantStream && typeof assistantStream.revision === 'number' ? assistantStream.revision : 0;
    var active = assistantStream && assistantStream.activeAttempt;
    if (active && active.attemptId) this._restoreAttempt(active);
  };

  DSHTranscript.prototype._restoreAttempt = function (active) {
    var item = {
      id: 'a-' + active.attemptId,
      kind: 'assistant',
      reasoning: '',
      text: '',
      blocks: [],
      streaming: true,
      attemptId: active.attemptId,
      turn: active.turn,
      step: active.step,
      seq: null,
      time: null,
    };
    if (this._has(item.id)) return;
    this._append(item);
    var stream = {
      attemptId: active.attemptId,
      item: item,
      expectedIndex: 0,
      pendingCommitSeq: null,
      blocks: [],
      blocksByIndex: {},
      usage: null,
      finish: null,
    };
    this._stream = stream;
    var chunks = expandStreamRecords(active.stream || []);
    for (var i = 0; i < chunks.length; i += 1) this._applyChunk(stream, chunks[i]);
    stream.expectedIndex = typeof active.nextIndex === 'number' ? active.nextIndex : chunks.length;
  };

  // Expand compact AssistantStreamRecord[] ({type:'chunk'|'text-chunks'|
  // 'reasoning-chunks'|'tool-call-chunks'}) to plain StreamChunk values.
  function expandStreamRecords(records) {
    var chunks = [];
    if (!records) return chunks;
    for (var i = 0; i < records.length; i += 1) {
      var rec = records[i];
      if (!rec || typeof rec !== 'object') continue;
      if (rec.type === 'chunk') {
        if (rec.chunk) chunks.push(rec.chunk);
        continue;
      }
      var members = rec.type === 'tool-call-chunks' ? rec.args : rec.texts;
      if (!members || !members.length) continue;
      for (var j = 0; j < members.length; j += 1) {
        if (rec.type === 'text-chunks') chunks.push({ type: 'text-delta', index: rec.index, text: members[j] });
        else if (rec.type === 'reasoning-chunks') chunks.push({ type: 'reasoning-delta', index: rec.index, text: members[j] });
        else if (rec.type === 'tool-call-chunks') {
          var delta = { type: 'tool-call-delta', index: rec.index, id: rec.id, argumentsDelta: members[j] };
          if (typeof rec.name === 'string') delta.name = rec.name;
          chunks.push(delta);
        }
      }
    }
    return chunks;
  }

  // -------------------------------------------------------------------------
  // Durable events
  // -------------------------------------------------------------------------

  DSHTranscript.prototype.applyEvent = function (value) {
    var ev = value && value.event ? value.event : value;
    if (!ev || typeof ev !== 'object' || !ev.type) return;
    this._applyEventTo(ev, this._items);
  };

  DSHTranscript.prototype._applyEventTo = function (ev, list) {
    var seq = typeof ev.seq === 'number' ? ev.seq : -1;
    if (!this._prepend) {
      if (seq >= 0 && seq <= this._lastSeq) return; // replay / duplicate
      if (seq > this._lastSeq) this._lastSeq = seq;
    }
    var data = ev.data || {};

    switch (ev.type) {
      case 'turn/start':
        this._turn = data.turn || this._turn;
        this._running = true;
        break;
      case 'step/start':
        this._running = true;
        break;
      case 'turn/end':
        this._running = false;
        this._onTurnEnd(data, seq, list);
        break;
      case 'user/message':
        this._onUserMessage(data, ev, seq, list);
        break;
      case 'assistant/message':
        this._onAssistantMessage(data, ev, seq, list);
        break;
      case 'assistant/attempt':
        this._onHiddenAttempt(seq);
        break;
      case 'tool/call':
        this._onToolCall(data, ev, seq, list);
        break;
      case 'tool/result':
        this._onToolResult(data, ev, seq, list);
        break;
      case 'session/title':
        if (typeof data.title === 'string' && data.title) this._title = data.title;
        break;
      default:
        // system/developer/request/*/session-log-*/*internal: not rendered.
        break;
    }
  };

  DSHTranscript.prototype._onUserMessage = function (data, ev, seq, list) {
    var source = data.source || {};
    // Synthetic context injections (runtime-context, time-context, skills,
    // reminders, ...) are model-facing, not human prompts; hide them.
    if (source.kind !== 'user') return;
    var id = 'u-' + (seq >= 0 ? seq : 'x' + this._items.length);
    if (this._has(id)) return;
    var text = textOfContent(data.content);
    if (!text) return;
    var item = { id: id, kind: 'user', text: text, seq: seq, time: ev.time || null };
    this._appendItem(item, list);
  };

  DSHTranscript.prototype._onAssistantMessage = function (data, ev, seq, list) {
    var message = data.message || {};
    var content = message.content || [];
    var blocks = visibleBlocks(content);
    var text = '';
    var reasoning = '';
    for (var i = 0; i < blocks.length; i += 1) {
      if (blocks[i].type === 'text') text += blocks[i].text;
      else reasoning += blocks[i].text;
    }
    var interrupted = data.interrupted === true;
    var visible = !!(text || reasoning || interrupted);

    // Durable tool-call blocks are paired with later tool/call+tool/result
    // events; only materialize a card early when it is missing (after the
    // assistant bubble is positioned, so tool cards render below it).
    function materializeToolCards(self) {
      for (var j = 0; j < content.length; j += 1) {
        var b = content[j];
        if (b && b.type === 'tool-call' && b.id && !self._byCallId.has(b.id)) {
          self._setToolCall(b.id, b.name, typeof b.arguments === 'string' ? b.arguments : '', seq, ev.time || null, list);
        }
      }
    }

    if (!visible) {
      materializeToolCards(this);
      return; // tool-only / empty attempt
    }
    var live = this._matchLiveItem(seq, data.turn, data.step);
    if (live) {
      live.text = text;
      live.reasoning = reasoning;
      live.blocks = blocks;
      live.streaming = false;
      live.interrupted = interrupted || false;
      live.seq = seq;
      live.time = ev.time || live.time || null;
      live._promoted = true;
      delete live.pendingCommitSeq;
      this._stream = null;
      this._lastLive = null;
      materializeToolCards(this);
      if (!text && !reasoning && !interrupted) this._remove(live);
    } else {
      var id = 'a-' + seq;
      if (this._has(id)) return;
      var item = {
        id: id,
        kind: 'assistant',
        reasoning: reasoning,
        text: text,
        blocks: blocks,
        streaming: false,
        interrupted: interrupted,
        attemptId: null,
        seq: seq,
        time: ev.time || null,
        _promoted: true,
      };
      this._appendItem(item, list);
      materializeToolCards(this);
    }
    if (interrupted) this._notice('interrupted-' + seq, 'warn', 'Response interrupted.', seq, list);
  };

  DSHTranscript.prototype._onHiddenAttempt = function (seq) {
    var live = this._stream && this._stream.item;
    if (!live) live = this._lastLive;
    if (live && (live.pendingCommitSeq === seq || live.seq == null)) {
      // Committed attempt that produced no visible message: drop placeholder.
      this._remove(live);
      this._stream = null;
      this._lastLive = null;
    }
  };

  DSHTranscript.prototype._matchLiveItem = function (seq, turn, step) {
    var stream = this._stream;
    if (stream && stream.item && !stream.item._promoted) {
      if (stream.pendingCommitSeq === seq) return stream.item;
      if (stream.item.turn === turn && stream.item.step === step) return stream.item;
    }
    var last = this._lastLive;
    if (last && !last._promoted && last.seq == null) {
      if (last.pendingCommitSeq === seq) return last;
      if (last.turn === turn && last.step === step) return last;
    }
    return null;
  };

  DSHTranscript.prototype._onToolCall = function (data, ev, seq, list) {
    var callId = data.callId;
    if (!callId) return;
    this._setToolCall(callId, data.name, typeof data.arguments === 'string' ? data.arguments : '', seq, ev.time || null, list);
  };

  DSHTranscript.prototype._setToolCall = function (callId, name, argsText, seq, time, list) {
    var item = this._byCallId.get(callId);
    if (item) {
      if (name) item.name = name;
      if (typeof argsText === 'string' && argsText.length) item.argsText = argsText;
      if (seq >= 0) item.seq = seq;
      if (time) item.time = time;
      return item;
    }
    var id = 't-' + callId;
    if (this._has(id)) return this._byId.get(id);
    item = {
      id: id,
      kind: 'tool',
      callId: callId,
      name: name || 'tool',
      argsText: argsText || '',
      status: 'running',
      resultText: '',
      seq: seq,
      time: time || null,
    };
    this._byCallId.set(callId, item);
    this._appendItem(item, list);
    return item;
  };

  DSHTranscript.prototype._onToolResult = function (data, ev, seq, list) {
    var message = data.message || {};
    var callId = message.toolCallId || (message.source && message.source.callId) || data.callId;
    if (!callId) return;
    var item = this._byCallId.get(callId);
    if (!item) item = this._setToolCall(callId, 'tool', '', seq, ev.time || null, list);
    var isError = message.isError === true || !!data.error;
    item.status = isError ? 'error' : 'ok';
    item.resultText = textOfContent(message.content);
    item.seq = seq;
  };

  DSHTranscript.prototype._onTurnEnd = function (data, seq, list) {
    var reason = data.reason || {};
    var kind = reason.kind;
    if (kind === 'completed' || kind === 'forked' || !kind) return;
    var turn = data.turn;
    var text;
    var tone = 'warn';
    if (kind === 'aborted' || kind === 'cancelled') text = 'Stopped.';
    else if (kind === 'interrupted') text = 'Interrupted.';
    else if (kind === 'max-tokens') text = 'Response hit the token limit.';
    else if (kind === 'error') {
      tone = 'error';
      var msg = reason.error && (reason.error.message || reason.error.code);
      text = msg ? 'Turn failed: ' + msg : 'Turn failed.';
    } else if (kind === 'blocked') text = 'Turn blocked.';
    else text = 'Turn ended: ' + kind;
    this._notice('turn-' + (turn || seq) + '-end', tone, text, seq, list);
  };

  DSHTranscript.prototype._notice = function (key, tone, text, seq, list) {
    if (this._noticeKeys.has(key)) return;
    this._noticeKeys.set(key, true);
    var item = { id: 'n-' + key, kind: 'notice', tone: tone, text: text, seq: seq };
    this._appendItem(item, list);
  };

  DSHTranscript.prototype._appendItem = function (item, list) {
    if (list && list !== this._items) {
      // Older history being prepended; keep the global id map for pairing.
      if (this._byId.has(item.id)) return;
      list.push(item);
      this._byId.set(item.id, item);
      return;
    }
    this._append(item);
  };

  // -------------------------------------------------------------------------
  // Live assistant stream frames
  // -------------------------------------------------------------------------

  DSHTranscript.prototype.applyAssistantFrame = function (value) {
    var frame = value && value.frame ? value.frame : value;
    if (!frame || !frame.type) return;
    var revision = typeof frame.revision === 'number' ? frame.revision : -1;
    if (revision >= 0 && revision <= this._baselineRevision) return; // replay covered by snapshot
    if (frame.type === 'start') this._streamStart(frame);
    else if (frame.type === 'chunk') this._streamChunk(frame);
    else if (frame.type === 'end') this._streamEnd(frame);
  };

  DSHTranscript.prototype._streamStart = function (frame) {
    if (this._stream && this._stream.attemptId === frame.attemptId) return;
    // A new attempt implicitly closes any previous partial one.
    if (this._stream && this._stream.item && this._stream.item.streaming) this._stream.item.streaming = false;
    var attemptId = frame.attemptId || 'live';
    var item = {
      id: 'a-' + attemptId,
      kind: 'assistant',
      reasoning: '',
      text: '',
      blocks: [],
      streaming: true,
      attemptId: attemptId,
      turn: frame.turn,
      step: frame.step,
      seq: null,
      time: null,
    };
    if (this._has(item.id)) {
      item = this._byId.get(item.id);
      item.streaming = true;
      item.text = '';
      item.reasoning = '';
      item.blocks = [];
      item.seq = null;
    } else {
      this._append(item);
    }
    this._stream = {
      attemptId: attemptId,
      item: item,
      expectedIndex: 0,
      pendingCommitSeq: null,
      blocks: [],
      blocksByIndex: {},
      usage: null,
      finish: null,
    };
  };

  DSHTranscript.prototype._streamChunk = function (frame) {
    var chunk = frame.chunk;
    if (!chunk || typeof chunk !== 'object') return;
    if (!this._stream) {
      var known = chunk.type === 'block-start' || chunk.type === 'block-end' ||
        chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ||
        chunk.type === 'tool-call-delta' || chunk.type === 'usage' || chunk.type === 'finish';
      if (!known) return; // unknown chunk without a tracked attempt: ignore
      this._streamStart({ attemptId: frame.attemptId, turn: null, step: null });
    }
    var stream = this._stream;
    if (frame.index !== undefined && typeof frame.index === 'number') {
      if (frame.index < stream.expectedIndex) return; // replayed chunk
      stream.expectedIndex = frame.index + 1;
    }
    this._applyChunk(stream, frame.chunk);
  };

  DSHTranscript.prototype._applyChunk = function (stream, chunk) {
    if (!chunk || typeof chunk !== 'object') return;
    switch (chunk.type) {
      case 'block-start': {
        var block = { type: chunk.blockType || 'text', text: '' };
        stream.blocksByIndex[chunk.index] = block;
        stream.blocks.push(block);
        break;
      }
      case 'text-delta':
        this._addDelta(stream, chunk.index, 'text', typeof chunk.text === 'string' ? chunk.text : '');
        break;
      case 'reasoning-delta':
        this._addDelta(stream, chunk.index, 'reasoning', typeof chunk.text === 'string' ? chunk.text : '');
        break;
      case 'tool-call-delta':
        if (chunk.id) this._appendToolDelta(chunk.id, chunk.name, chunk.argumentsDelta);
        break;
      case 'block-end': {
        var full = chunk.block || {};
        var target = stream.blocksByIndex[chunk.index];
        if (full.type === 'text' || full.type === 'reasoning') {
          if (!target) {
            target = { type: full.type, text: '' };
            stream.blocksByIndex[chunk.index] = target;
            stream.blocks.push(target);
          }
          if (typeof full.text === 'string') target.text = full.text;
          this._refreshItemText(stream);
        } else if (full.type === 'tool-call' && full.id) {
          this._setToolCall(full.id, full.name, typeof full.arguments === 'string' ? full.arguments : '', -1, null);
        }
        break;
      }
      case 'usage':
        stream.usage = chunk.usage || null;
        break;
      case 'finish':
        stream.finish = chunk.reason || null;
        break;
      default:
        break;
    }
  };

  DSHTranscript.prototype._addDelta = function (stream, index, type, text) {
    if (!text) return;
    var idx = typeof index === 'number' ? index : 0;
    var block = stream.blocksByIndex[idx];
    if (!block) {
      block = { type: type, text: '' };
      stream.blocksByIndex[idx] = block;
      stream.blocks.push(block);
    }
    if (block.type !== type) block.type = type;
    block.text += text;
    this._refreshItemText(stream);
  };

  DSHTranscript.prototype._refreshItemText = function (stream) {
    // Blocks are few (<10); recomputing keeps interleaved text/reasoning exact.
    var text = '';
    var reasoning = '';
    for (var i = 0; i < stream.blocks.length; i += 1) {
      var b = stream.blocks[i];
      if (b.type === 'text') text += b.text;
      else if (b.type === 'reasoning') reasoning += b.text;
    }
    stream.item.text = text;
    stream.item.reasoning = reasoning;
    stream.item.blocks = stream.blocks.map(function (b) { return { type: b.type, text: b.text }; });
  };

  DSHTranscript.prototype._appendToolDelta = function (callId, name, argumentsDelta) {
    var item = this._byCallId.get(callId);
    if (!item) item = this._setToolCall(callId, name || null, '', -1, null);
    if (!item) return;
    if (name) item.name = name;
    if (typeof argumentsDelta === 'string') item.argsText += argumentsDelta;
  };

  DSHTranscript.prototype._streamEnd = function (frame) {
    var outcome = frame.outcome || {};
    var stream = this._stream;
    var item = stream ? stream.item : null;
    if (!stream) {
      // Terminal frame without a tracked attempt (e.g. baseline edge): look up
      // by attempt id if the item exists.
      if (frame.attemptId) item = this._byId.get('a-' + frame.attemptId) || null;
      if (!item) return;
    }
    if (outcome.kind === 'committed') {
      if (outcome.eventType === 'assistant/attempt') {
        this._remove(item);
        if (this._stream === stream) this._stream = null;
        return;
      }
      item.streaming = false;
      item.pendingCommitSeq = typeof outcome.seq === 'number' ? outcome.seq : null;
      if (stream) stream.pendingCommitSeq = item.pendingCommitSeq;
      this._lastLive = item;
      // Keep this._stream so the durable assistant/message can promote the
      // same item (stable id -> no DOM flicker / no duplicate bubble).
      if (stream) stream.committed = true;
    } else {
      // abandoned: the turn continues but this attempt is final.
      item.streaming = false;
      item.interrupted = true;
      this._lastLive = item;
      if (!item.text && !item.reasoning) this._remove(item);
      if (this._stream === stream) this._stream = null;
    }
  };

  DSHTranscript.prototype.applyStreamEnd = function (value) {
    var frame = value && value.frame ? value.frame : value;
    // Accept only the generation-level terminal marker (it always carries an
    // outcome). The transport-level end envelope {type:'end',streamId} is a
    // no-op here and must not be mistaken for an abandoned attempt.
    if (!frame || frame.type !== 'end' || !frame.outcome) return;
    this._streamEnd(frame);
  };

  // -------------------------------------------------------------------------
  // History paging
  // -------------------------------------------------------------------------

  DSHTranscript.prototype.prependRecords = function (records, hasMore) {
    if (hasMore !== undefined && hasMore !== null) this._hasMore = !!hasMore;
    if (!records || !records.length) return;
    var prepended = [];
    var previousPrepend = this._prepend;
    this._prepend = true;
    try {
      for (var i = 0; i < records.length; i += 1) {
        var ev = records[i] && records[i].event ? records[i].event : records[i];
        if (ev && ev.type) this._applyEventTo(ev, prepended);
      }
    } finally {
      this._prepend = previousPrepend;
    }
    if (!prepended.length) return;
    this._items = prepended.concat(this._items);
  };

  // -------------------------------------------------------------------------
  // Public getters
  // -------------------------------------------------------------------------

  Object.defineProperty(DSHTranscript.prototype, 'items', {
    get: function () { return this._items; },
  });
  Object.defineProperty(DSHTranscript.prototype, 'title', {
    get: function () { return this._title; },
  });
  Object.defineProperty(DSHTranscript.prototype, 'running', {
    get: function () { return this._running; },
  });
  Object.defineProperty(DSHTranscript.prototype, 'cursor', {
    get: function () { return this._cursor; },
  });
  Object.defineProperty(DSHTranscript.prototype, 'hasMore', {
    get: function () { return this._hasMore; },
  });
  Object.defineProperty(DSHTranscript.prototype, 'lastSeq', {
    get: function () { return this._lastSeq; },
  });
  Object.defineProperty(DSHTranscript.prototype, 'header', {
    get: function () { return this._header; },
  });
  Object.defineProperty(DSHTranscript.prototype, 'streamingItem', {
    get: function () { return this._stream ? this._stream.item : null; },
  });

  DSHTranscript.util = { expandStreamRecords: expandStreamRecords };

  if (typeof module !== 'undefined' && module.exports) module.exports = DSHTranscript;
  if (root) root.DSHTranscript = DSHTranscript;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
