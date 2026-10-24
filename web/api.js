/*!
 * DSHClient — classic-script client for the DeepSeek Harness web wire protocol.
 *
 * Target: Android WebView 91 (Chrome 91), no modules. Also loadable from Node
 * for tooling by passing a WebSocket implementation.
 *
 * Auth model: same-origin cookie set by the native shell (or the dev proxy) via
 * GET /?token=... . Every HTTP and WebSocket request must carry it; the browser
 * / WebView does that automatically for same-origin requests.
 *
 * Wire protocol (verified against live dsh web, see docs/PROTOCOL-NOTES.md):
 *   unary   POST /api/<endpoint>  {type:'client-request',rpcId,method,payload:{args}}
 *           response {type:'server-response',rpcId,result:{ok,value|error}}
 *   streams one WS /api/remote.mux; open/item/error/end/cancel envelopes.
 */
(function (root) {
  'use strict';

  var STATUS_OFFLINE = 'offline';
  var STATUS_CONNECTING = 'connecting';
  var STATUS_CONNECTED = 'connected';
  var STATUS_RECONNECTING = 'reconnecting';

  var RPC_TIMEOUT_MS = 60000;
  var OPEN_TIMEOUT_MS = 20000;
  var LIVENESS_INTERVAL_MS = 30000;
  var STALE_AFTER_MS = 90000;
  var MAX_BACKOFF_MS = 30000;

  function noop() {}

  function uuid() {
    var c = typeof crypto !== 'undefined' ? crypto : (root && root.crypto) || null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (var i = 0; i < 16; i += 1) bytes[i] = (Math.random() * 256) | 0;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = '';
    for (var j = 0; j < 16; j += 1) hex += (bytes[j] + 256).toString(16).slice(1);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function errWithCode(code, message, details) {
    var err = new Error(message || code);
    err.code = code;
    if (details !== undefined) err.details = details;
    return err;
  }

  function DSHClient(options) {
    options = options || {};
    this.baseUrl = String(options.baseUrl || defaultBaseUrl()).replace(/\/+$/, '');
    this._fetch = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(root || globalThis) : null);
    this._WebSocket = options.WebSocketImpl || (root && root.WebSocket) || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this._extraHeaders = options.headers || null;

    this.onSnapshot = options.onSnapshot || noop;
    this.onEvent = options.onEvent || noop;
    this.onAssistantFrame = options.onAssistantFrame || noop;
    this.onStreamEnd = options.onStreamEnd || noop;
    this.onStatus = options.onStatus || noop;
    this.onError = options.onError || noop;
    this.onAuthError = options.onAuthError || noop;

    this.status = STATUS_OFFLINE;
    this.sessionId = null; // currently followed session, if any
    this.isFollowing = false;

    this._ws = null;
    this._wsOpen = false;
    this._manualClose = false;
    this._connectPromise = null;
    this._pendingOpen = null;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._connectingSince = 0;
    this._lastActivity = 0;
    this._livenessTimer = null;
    this._streams = {}; // streamId -> {kind:'follow'|'other', sessionId}
    this._follow = null; // {sessionId, maxMessages}
    this._followStreamId = null;
    this._followWaiters = []; // {resolve, reject, timer}
    this._rpcSeq = 0;
    this._closed = false;
  }

  function defaultBaseUrl() {
    if (root && root.location && /^https?:/.test(root.location.origin || '')) return root.location.origin;
    try {
      if (root && root.document && root.document.baseURI) {
        var m = /^(https?:\/\/[^/]+)/.exec(root.document.baseURI);
        if (m) return m[1];
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  // -------------------------------------------------------------------------
  // Internal plumbing
  // -------------------------------------------------------------------------

  DSHClient.prototype._setStatus = function (status) {
    if (this.status === status) return;
    this.status = status;
    try { this.onStatus(status); } catch (e) { this.onError(e); }
  };

  DSHClient.prototype._emit = function (name, value) {
    var fn = this[name];
    if (typeof fn !== 'function') return;
    try { fn(value); } catch (e) { this.onError(e); }
  };

  DSHClient.prototype._emitError = function (err) {
    try { this.onError(err); } catch (e) { /* ignore */ }
  };

  DSHClient.prototype._authError = function (err) {
    var self = this;
    this._setStatus(STATUS_OFFLINE);
    this._stopReconnect();
    try { this.onAuthError(err); } catch (e) { this._emitError(e); }
    // Reject every pending follow waiter: auth failure is terminal until the
    // native shell re-authenticates and the page is reloaded/connect() called.
    var waiters = this._followWaiters;
    this._followWaiters = [];
    waiters.forEach(function (w) {
      clearTimeout(w.timer);
      w.reject(err);
    });
    if (self._pendingOpen) {
      var p = self._pendingOpen;
      self._pendingOpen = null;
      p.reject(err);
    }
  };

  DSHClient.prototype._post = function (path, body) {
    var self = this;
    var url = this.baseUrl + path;
    var headers = { 'content-type': 'application/json' };
    if (this._extraHeaders) {
      Object.keys(this._extraHeaders).forEach(function (k) { headers[k] = self._extraHeaders[k]; });
    }
    if (this._fetch) {
      var controller = null;
      var timer = null;
      var init = { method: 'POST', headers: headers, body: body, credentials: 'same-origin' };
      if (typeof AbortController === 'function') {
        controller = new AbortController();
        init.signal = controller.signal;
        timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, RPC_TIMEOUT_MS);
      }
      return this._fetch(url, init).then(function (res) {
        if (timer) clearTimeout(timer);
        return res.text().then(function (text) {
          return { status: res.status, text: text };
        });
      }, function (e) {
        if (timer) clearTimeout(timer);
        throw errWithCode('network', 'network request failed: ' + (e && e.message ? e.message : e));
      });
    }
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('content-type', 'application/json');
      xhr.timeout = RPC_TIMEOUT_MS;
      if (self._extraHeaders) {
        Object.keys(self._extraHeaders).forEach(function (k) {
          try { xhr.setRequestHeader(k, self._extraHeaders[k]); } catch (e) {}
        });
      }
      xhr.onload = function () { resolve({ status: xhr.status, text: xhr.responseText }); };
      xhr.onerror = function () { reject(errWithCode('network', 'network request failed')); };
      xhr.ontimeout = function () { reject(errWithCode('timeout', 'request timed out')); };
      xhr.send(body);
    });
  };

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // Unary RPC: resolves with result.value, throws Error with .code/.details.
  DSHClient.prototype._rpc = function (method, args) {
    var self = this;
    var rpcId = uuid();
    var body = JSON.stringify({
      type: 'client-request',
      rpcId: rpcId,
      method: method,
      payload: { args: args || {} },
    });
    return this._post('/api/' + method, body).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        var authErr = errWithCode('unauthorized', 'not authenticated (HTTP ' + res.status + ')');
        self._authError(authErr);
        throw authErr;
      }
      var json = parseJson(res.text);
      if (!json) {
        throw errWithCode(res.status === 200 ? 'bad-response' : 'http-' + res.status,
          'unexpected non-JSON response (HTTP ' + res.status + '): ' + String(res.text || '').slice(0, 200));
      }
      if (json.type !== 'server-response') {
        throw errWithCode('bad-response', 'unexpected envelope type: ' + json.type);
      }
      var result = json.result || {};
      if (!result.ok) {
        var error = result.error || {};
        var err = errWithCode(error.code || 'rpc-error', error.message || 'request failed', error.details);
        if (/unauthor|forbidden/i.test(error.code || '')) self._authError(err);
        throw err;
      }
      return result.value;
    });
  };

  // -------------------------------------------------------------------------
  // WebSocket lifecycle
  // -------------------------------------------------------------------------

  DSHClient.prototype._wsUrl = function () {
    var base = this.baseUrl || defaultBaseUrl();
    var wsBase = base.replace(/^http/i, 'ws');
    if (!wsBase) throw errWithCode('config', 'no baseUrl available for WebSocket');
    return wsBase + '/api/remote.mux';
  };

  DSHClient.prototype.connect = function () {
    if (this._closed) return Promise.reject(errWithCode('closed', 'client was closed'));
    if (this._wsOpen) return Promise.resolve();
    if (this._connectPromise) return this._connectPromise;
    if (!this._WebSocket) return Promise.reject(errWithCode('config', 'WebSocket implementation not available'));
    var self = this;
    this._manualClose = false;
    this._connectPromise = new Promise(function (resolve, reject) {
      self._pendingOpen = { resolve: resolve, reject: reject };
    });
    this._openSocket(STATUS_CONNECTING);
    return this._connectPromise;
  };

  DSHClient.prototype._openSocket = function (status) {
    var self = this;
    if (this._closed || this._manualClose) return;
    this._setStatus(status);
    this._connectingSince = Date.now();
    var ws;
    try {
      ws = new this._WebSocket(this._wsUrl());
    } catch (e) {
      this._onSocketFailure(errWithCode('network', 'WebSocket open failed: ' + e.message));
      return;
    }
    this._ws = ws;
    this._wsOpen = false;
    ws.onopen = function () {
      if (self._ws !== ws) return;
      self._wsOpen = true;
      self._connectingSince = 0;
      self._reconnectAttempt = 0;
      self._lastActivity = Date.now();
      self._setStatus(STATUS_CONNECTED);
      self._startLiveness();
      var pending = self._pendingOpen;
      self._pendingOpen = null;
      if (pending) pending.resolve();
      self._connectPromise = null;
      self._resumeFollow();
    };
    ws.onmessage = function (evt) {
      if (self._ws !== ws) return;
      self._lastActivity = Date.now();
      self._handleFrame(evt && evt.data !== undefined ? evt.data : evt);
    };
    ws.onerror = function () {
      if (self._ws !== ws) return;
      // Browsers intentionally hide handshake details here; onclose follows.
    };
    ws.onclose = function () {
      if (self._ws !== ws) return;
      var wasOpen = self._wsOpen;
      self._ws = null;
      self._wsOpen = false;
      self._followStreamId = null;
      self._streams = {};
      if (self._manualClose || self._closed) {
        self._setStatus(STATUS_OFFLINE);
        return;
      }
      if (!wasOpen) {
        self._onSocketFailure(errWithCode('network', 'WebSocket connection failed'));
      } else {
        // An established connection dropped: reconnect with backoff and re-follow.
        self._setStatus(STATUS_RECONNECTING);
        self._scheduleReconnect();
      }
    };
  };

  DSHClient.prototype._onSocketFailure = function (err) {
    var self = this;
    // A WS handshake rejection looks like a plain network failure in browsers;
    // probe an authenticated unary endpoint to tell "bad/expired cookie" apart
    // from "host unreachable".
    this._probeAuth().then(function (authError) {
      if (authError) {
        self._authError(authError);
        return;
      }
      var pending = self._pendingOpen;
      self._pendingOpen = null;
      self._setStatus(STATUS_RECONNECTING);
      if (pending) pending.reject(self._authErrorPending ? self._authErrorPending : err);
      self._scheduleReconnect();
    });
  };

  DSHClient.prototype._probeAuth = function () {
    var self = this;
    this._authErrorPending = null;
    var probe = this._rpc('session/modelCatalog', {}).then(function () { return null; }, function (e) {
      if (e && (e.code === 'unauthorized' || /unauthor/i.test(e.code || ''))) {
        self._authErrorPending = e;
        return e;
      }
      return null;
    });
    // A failed WS handshake must not stall the reconnect loop for the full RPC
    // timeout when the host is unreachable.
    return Promise.race([probe, new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 8000); })]);
  };

  DSHClient.prototype._scheduleReconnect = function () {
    var self = this;
    if (this._closed || this._manualClose || this._reconnectTimer) return;
    var attempt = this._reconnectAttempt += 1;
    var delay = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, Math.min(attempt - 1, 5)));
    delay += Math.floor(Math.random() * 300);
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      if (self._closed || self._manualClose) return;
      if (self._ws) return;
      self._openSocket(STATUS_RECONNECTING);
    }, delay);
  };

  DSHClient.prototype._stopReconnect = function () {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  };

  DSHClient.prototype._startLiveness = function () {
    var self = this;
    this._stopLiveness();
    this._livenessTimer = setInterval(function () {
      if (self._closed || self._manualClose) return;
      var now = Date.now();
      if (!self._ws) {
        if (!self._reconnectTimer) self._scheduleReconnect();
        return;
      }
      if (!self._wsOpen) {
        // A socket stuck in CONNECTING for >30s is treated as dead.
        if (self._connectingSince && now - self._connectingSince > LIVENESS_INTERVAL_MS) {
          try { self._ws.close(); } catch (e) {}
        }
        return;
      }
      if (self._follow && now - self._lastActivity > STALE_AFTER_MS) {
        // Zombie socket: no frame for 90s while a live follow should be quiet
        // only if nothing is running; force a clean reconnect.
        try { self._ws.close(); } catch (e) {}
      }
    }, LIVENESS_INTERVAL_MS);
    if (this._livenessTimer && typeof this._livenessTimer.unref === 'function') this._livenessTimer.unref();
  };

  DSHClient.prototype._stopLiveness = function () {
    if (this._livenessTimer) {
      clearInterval(this._livenessTimer);
      this._livenessTimer = null;
    }
  };

  DSHClient.prototype._sendFrame = function (frame) {
    if (!this._ws || !this._wsOpen) return false;
    try {
      this._ws.send(JSON.stringify(frame));
      return true;
    } catch (e) {
      this._emitError(errWithCode('network', 'WebSocket send failed: ' + e.message));
      return false;
    }
  };

  // -------------------------------------------------------------------------
  // Incoming stream frames
  // -------------------------------------------------------------------------

  DSHClient.prototype._handleFrame = function (data) {
    var frame;
    if (typeof data === 'string') frame = parseJson(data);
    else if (data && typeof data === 'object' && data.type) frame = data; // Node ws gives Buffer; JSON parse path below
    if (!frame && typeof data !== 'string' && typeof Buffer !== 'undefined' && Buffer && typeof Buffer.from === 'function') {
      try { frame = parseJson(Buffer.from(data).toString('utf8')); } catch (e) { frame = null; }
    }
    if (!frame || typeof frame !== 'object') return;
    var streamId = frame.streamId;
    if (!streamId) return;

    if (frame.type === 'item') {
      var kind = this._streamKind(streamId);
      var value = frame.value;
      if (!value || typeof value !== 'object') return;
      if (kind === 'follow') {
        if (value.type === 'snapshot') {
          this._resolveFollowWaiters(null, kind);
          this._emit('onSnapshot', value);
        } else if (value.type === 'assistant-stream') {
          this._emit('onAssistantFrame', value);
          // A stream 'end' frame is the generation-level terminal marker; the
          // transport-level 'end' envelope follows separately.
          if (value.frame && value.frame.type === 'end') this._emit('onStreamEnd', value);
        } else if (value.type === 'event') {
          this._emit('onEvent', value);
        }
      }
      return;
    }
    if (frame.type === 'error') {
      var err = errWithCode((frame.error && frame.error.code) || 'stream-error',
        (frame.error && frame.error.message) || 'stream failed', frame.error && frame.error.details);
      if (this._streamKind(streamId) === 'follow') {
        this._resolveFollowWaiters(err, 'follow');
        if (err.code === 'unauthorized' || /unauthor/i.test(err.code)) this._authError(err);
        else this._emitError(err);
      } else {
        this._emitError(err);
      }
      return;
    }
    if (frame.type === 'end') {
      if (this._streamKind(streamId) === 'follow') {
        this._followStreamId = null;
        this._resolveFollowWaiters(null, 'follow');
        this._emit('onStreamEnd', { type: 'end', streamId: streamId });
      }
      return;
    }
  };

  DSHClient.prototype._streamKind = function (streamId) {
    var entry = this._streams[streamId];
    return entry ? entry.kind : null;
  };

  DSHClient.prototype._resolveFollowWaiters = function (err, kind) {
    if (kind !== 'follow' || this._followWaiters.length === 0) return;
    var waiters = this._followWaiters;
    this._followWaiters = [];
    waiters.forEach(function (w) {
      clearTimeout(w.timer);
      if (err) w.reject(err);
      else w.resolve();
    });
  };

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  DSHClient.prototype.listSessions = function () {
    return this._rpc('session/list', { _request: {} }).then(function (value) {
      return (value && value.items) || [];
    });
  };

  DSHClient.prototype.createSession = function (opts) {
    opts = opts || {};
    var request = {};
    if (opts.cwd) request.cwd = opts.cwd;
    if (opts.agentPreset) request.agentPreset = opts.agentPreset;
    return this._rpc('session/create', { request: request });
  };

  DSHClient.prototype.follow = function (sessionId, opts) {
    if (!sessionId) return Promise.reject(errWithCode('config', 'sessionId is required'));
    opts = opts || {};
    var maxMessages = opts.maxMessages || 40;
    var self = this;
    this.sessionId = sessionId;
    this.isFollowing = true;
    this._follow = { sessionId: sessionId, maxMessages: maxMessages };

    var wait = new Promise(function (resolve, reject) {
      var waiter = { resolve: resolve, reject: reject, timer: null };
      waiter.timer = setTimeout(function () {
        var idx = self._followWaiters.indexOf(waiter);
        if (idx >= 0) self._followWaiters.splice(idx, 1);
        reject(errWithCode('timeout', 'timed out waiting for follow snapshot'));
      }, OPEN_TIMEOUT_MS);
      self._followWaiters.push(waiter);
    });

    if (this._wsOpen) {
      this._openFollowStream();
    } else {
      this.connect().catch(function (e) {
        if (e && (e.code === 'unauthorized' || e.code === 'config' || e.code === 'closed')) {
          self._resolveFollowWaiters(e, 'follow');
        }
      });
    }
    return wait;
  };

  DSHClient.prototype._openFollowStream = function () {
    if (!this._wsOpen || !this._follow) return;
    // Cancel a previous follow stream but keep the socket: one physical WS is
    // multiplexed, though this client only needs one follow stream at a time.
    if (this._followStreamId) {
      this._sendFrame({ type: 'cancel', streamId: this._followStreamId });
      delete this._streams[this._followStreamId];
    }
    var streamId = uuid();
    this._followStreamId = streamId;
    this._streams[streamId] = { kind: 'follow', sessionId: this._follow.sessionId };
    this._sendFrame({
      type: 'open',
      streamId: streamId,
      endpoint: 'session/follow',
      payload: {
        args: {
          request: {
            address: { kind: 'session', sessionId: this._follow.sessionId },
            maxMessages: this._follow.maxMessages,
            assistantStream: true,
          },
        },
      },
    });
  };

  DSHClient.prototype._resumeFollow = function () {
    if (this._follow) this._openFollowStream();
  };

  DSHClient.prototype.unfollow = function () {
    this.isFollowing = false;
    this._follow = null;
    if (this._followStreamId) {
      this._sendFrame({ type: 'cancel', streamId: this._followStreamId });
      delete this._streams[this._followStreamId];
      this._followStreamId = null;
    }
    this._resolveFollowWaiters(errWithCode('cancelled', 'follow cancelled'), 'follow');
    return Promise.resolve();
  };

  DSHClient.prototype.sendPrompt = function (sessionId, text, opts) {
    opts = opts || {};
    var request = {
      requestId: uuid(),
      sessionId: sessionId,
      mode: opts.mode || 'queue',
      content: [{ type: 'text', text: String(text) }],
      clientTimeZone: opts.clientTimeZone || timeZone(),
    };
    return this._rpc('session/prompt', { request: request });
  };

  DSHClient.prototype.cancel = function (sessionId) {
    return this._rpc('session/cancel', { request: { sessionId: sessionId } });
  };

  DSHClient.prototype.pageOlder = function (sessionId, opts) {
    opts = opts || {};
    var request = {
      address: { kind: 'session', sessionId: sessionId },
      maxMessages: opts.maxMessages || 30,
    };
    if (opts.throughSeq !== undefined && opts.throughSeq !== null) request.throughSeq = opts.throughSeq;
    if (opts.beforeSeq !== undefined && opts.beforeSeq !== null) request.beforeSeq = opts.beforeSeq;
    return this._rpc('session/page', { request: request }).then(function (value) {
      return {
        records: (value && value.records) || [],
        hasMore: !!(value && value.hasMore),
      };
    });
  };

  DSHClient.prototype.modelCatalog = function () {
    return this._rpc('session/modelCatalog', {});
  };

  DSHClient.prototype.selectModel = function (sessionId, selection) {
    selection = selection || {};
    var request = { sessionId: sessionId };
    if (selection.provider !== undefined) request.provider = selection.provider;
    if (selection.model !== undefined) request.model = selection.model;
    if (selection.reasoningEffort !== undefined) request.reasoningEffort = selection.reasoningEffort;
    return this._rpc('session/selectModel', { request: request });
  };

  DSHClient.prototype.renameSession = function (sessionId, title) {
    return this._rpc('session/rename', { request: { sessionId: sessionId, title: String(title) } });
  };
  // Alias kept for callers that use the shorter name.
  DSHClient.prototype.rename = DSHClient.prototype.renameSession;

  DSHClient.prototype.close = function () {
    this._closed = false;
    this._manualClose = true;
    this._stopReconnect();
    this._stopLiveness();
    this._follow = null;
    this.isFollowing = false;
    this._followStreamId = null;
    this._streams = {};
    this._resolveFollowWaiters(errWithCode('closed', 'client closed'), 'follow');
    if (this._pendingOpen) {
      var pending = this._pendingOpen;
      this._pendingOpen = null;
      pending.reject(errWithCode('closed', 'client closed'));
    }
    this._connectPromise = null;
    if (this._ws) {
      try { this._ws.close(); } catch (e) {}
      this._ws = null;
    }
    this._wsOpen = false;
    this._setStatus(STATUS_OFFLINE);
  };

  // Re-open after a terminal auth failure (e.g. token refreshed in the shell).
  DSHClient.prototype.reopen = function () {
    this._closed = false;
    this._manualClose = false;
    this._reconnectAttempt = 0;
    this._authErrorPending = null;
    return this.connect();
  };

  function timeZone() {
    try {
      if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
        var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) return tz;
      }
    } catch (e) { /* ignore */ }
    return 'Asia/Shanghai';
  }

  DSHClient.util = { uuid: uuid, errWithCode: errWithCode };

  if (typeof module !== 'undefined' && module.exports) module.exports = DSHClient;
  if (root) root.DSHClient = DSHClient;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
