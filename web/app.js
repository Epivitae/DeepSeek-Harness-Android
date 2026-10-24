/* DSH Mobile — app controller
   Plain ES2019 browser script (Android WebView 91 compatible). */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- utils */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) { return window.DSHEscapeHtml ? window.DSHEscapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function md(s) { return window.DSHRenderMarkdown ? window.DSHRenderMarkdown(s || '') : esc(s || '').replace(/\n/g, '<br>'); }
  function icon(name, cls) { return '<svg class="i ' + (cls || '') + '"><use href="#i-' + name + '"/></svg>'; }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function basename(path) {
    if (!path) return '';
    var parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts.length ? parts[parts.length - 1] : path;
  }
  function relativeTime(ts) {
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 0) d = 0;
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
    var date = new Date(ts);
    return (date.getMonth() + 1) + '月' + date.getDate() + '日';
  }
  function prettyArgs(text) {
    if (!text) return '';
    var t = String(text).trim();
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { return t; }
  }
  function oneLine(s, max) {
    var t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > (max || 90) ? t.slice(0, max || 90) + '…' : t;
  }
  function storeGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var DEFAULT_CWD = '/root';
  var IS_TOUCH = (function () {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return true; }
  })();

  /* ---------------------------------------------------------------- state */

  var state = {
    screen: 'home',
    wide: false,
    connection: 'connecting',
    release: null,
    sessions: [],
    sessionsLoaded: false,
    listError: null,
    listLoading: false,
    client: null,
    mock: false,
    catalog: null,
    catalogAt: 0,
    sheetOpen: false,
    toastTimer: null,
    chat: null
  };

  var dom = {};

  function newChatState() {
    return {
      sessionId: null,
      cwd: storeGet('dsh.lastCwd', '') || '',
      title: null,
      model: null,
      transcript: null,
      items: [],
      signature: '',
      pinned: true,
      running: false,
      creating: false,
      sending: false,
      hasMore: false,
      cursor: 0,
      loadingOlder: false,
      streamError: null,
      openReasoning: {},
      openTools: {},
      pendingText: null,
      pendingUser: null,
      pendingSend: false,
      shownModelName: ''
    };
  }

  /* --------------------------------------------------------------- element */

  function refs() {
    dom.app = $('#app');
    dom.home = $('#view-home');
    dom.chat = $('#view-chat');
    dom.settings = $('#view-settings');
    dom.list = $('#session-list');
    dom.listHead = $('#list-head');
    dom.emptyHome = $('#empty-home');
    dom.homeScroll = $('#home-scroll');
    dom.sessionsLoadedAt = 0;
    dom.connBadge = $('#conn-badge');
    dom.connText = $('#conn-text');
    dom.chatTitle = $('#chat-title');
    dom.chatSub = $('#chat-sub-text');
    dom.chatStatusDot = $('#chat-status-dot');
    dom.chatScroll = $('#chat-scroll');
    dom.messages = $('#messages');
    dom.welcome = $('#welcome');
    dom.btnOlder = $('#btn-older');
    dom.input = $('#input');
    dom.send = $('#btn-send');
    dom.composer = $('#composer');
    dom.sheetLayer = $('#sheet-layer');
    dom.sheet = $('#sheet');
    dom.toast = $('#toast');
    dom.runStatus = $('#run-status');
    dom.runStatusText = $('#run-status-text');
    dom.btnStop = $('#btn-chat-stop');
    dom.chips = $('#composer-chips');
    dom.chipWorkspace = $('#chip-workspace');
    dom.chipWorkspaceText = $('#chip-workspace-text');
    dom.chipModel = $('#chip-model');
    dom.chipModelText = $('#chip-model-text');
    dom.settingsBody = $('#settings-body');
    dom.jump = $('#btn-jump');
    dom.btnNewChat = $('#btn-new-chat');
    dom.brandSub = $('#brand-sub');
    dom.splash = $('#app-splash');
  }

  /* ---------------------------------------------------------------- boot */

  function boot() {
    refs();
    setupWide();
    bindGlobalEvents();
    var mock = /[?&]mock=1/.test(location.search) || !window.DSHClient;
    state.mock = mock;
    if (mock) {
      initMock();
    } else {
      initClient();
    }
    setScreen('home');
    setConnection(state.connection);
    renderHome();
    if (state.wide) { openNewChat(true); }
    window.setTimeout(function () {
      dom.app.setAttribute('data-ready', '1');
      if (dom.splash) dom.splash.classList.add('is-hidden');
      nativeCall('pageReady');
    }, 80);
    window.setInterval(function () {
      if (document.hidden) return;
      if (state.mock) return;
      if (state.screen === 'home' || state.wide) {
        if (state.connection === 'connected') loadSessions(true);
      }
    }, 7000);
  }

  function nativeCall(method, a, b) {
    try {
      if (window.DSHNative && typeof window.DSHNative[method] === 'function') {
        return window.DSHNative[method](a, b);
      }
    } catch (e) { /* bridge unavailable in a plain browser */ }
    return null;
  }

  /* -------------------------------------------------------------- client */

  function initClient() {
    var Client = window.DSHClient;
    state.client = new Client({
      baseUrl: location.origin,
      onSnapshot: function (value) { handleSnapshot(value); },
      onEvent: function (value) { handleEvent(value); },
      onAssistantFrame: function (value) { handleAssistantFrame(value); },
      onStreamEnd: function (value) { handleStreamEnd(value); },
      onStatus: function (s) { state.connection = s; setConnection(s); if (s === 'connected') { loadSessions(!state.sessionsLoaded); } },
      onError: function (err) { console.warn('[dsh]', err); },
      onAuthError: function (err) { showAuthExpired(err); }
    });
    state.connection = 'connecting';
    setConnection('connecting');
    try {
      var p = state.client.connect();
      if (p && p.then) p.then(function () {}, function (err) { console.warn('[dsh] connect failed', err); });
    } catch (e) { console.warn('[dsh] connect threw', e); }
  }

  function loadSessions(silent) {
    if (!state.client || state.listLoading) return;
    state.listLoading = true;
    if (!silent) setRefreshBusy(true);
    Promise.resolve(state.client.listSessions()).then(function (items) {
      state.listLoading = false;
      state.sessionsLoaded = true;
      state.listError = null;
      state.sessions = (items || []).map(normalizeSession);
      renderHome();
      if (!silent) setRefreshBusy(false);
    }, function (err) {
      state.listLoading = false;
      state.listError = err || new Error('加载失败');
      renderHome();
      setRefreshBusy(false);
      if (!silent) toast((err && err.message) || '无法加载会话');
    });
  }

  function normalizeSession(item) {
    var pv = (item.projections && item.projections.values) || {};
    var ms = pv.modelSelection || null;
    var model = ms ? (ms.next || ms.lastUsed) : null;
    var blank = !!item.blank || !!(pv.sessionListMetadata && pv.sessionListMetadata.blank);
    return {
      id: item.sessionId,
      title: pv.title || null,
      cwd: item.cwd || '',
      running: !!item.running,
      updatedAt: item.updatedAt || 0,
      blank: blank,
      model: model,
      tokens: pv.tokenUsage || null,
      sessions: null
    };
  }

  function setRefreshBusy(busy) {
    var btn = $('#btn-refresh');
    if (btn) btn.classList.toggle('is-busy', !!busy);
  }

  function setConnection(s) {
    state.connection = s;
    if (dom.connBadge) {
      dom.connBadge.setAttribute('data-state', s);
      var map = { connecting: '连接中', connected: '已连接', reconnecting: '重连中', offline: '未连接' };
      if (dom.connText) dom.connText.textContent = map[s] || s;
    }
    if (dom.chatStatusDot) {
      dom.chatStatusDot.setAttribute('data-state', s === 'connected' ? 'idle' : (s === 'offline' ? 'error' : 'running'));
    }
    if (s === 'offline' && state.screen === 'chat' && state.chat && !state.chat.streamError) {
      state.chat.streamError = '连接已断开，正在尝试重连…';
      renderChat();
    }
  }

  /* --------------------------------------------------------- data events */

  function handleSnapshot(value) {
    var chat = state.chat;
    if (!chat || !chat.transcript) return;
    chat.transcript.reset(value);
    chat.cursor = value && typeof value.cursor === 'number' ? value.cursor : 0;
    chat.hasMore = !!(value && value.hasMore);
    chat.title = chat.transcript.title || chat.title;
    chat.streamError = null;
    chat.running = !!chat.transcript.running || false;
    if (chat.pendingUser) {
      var want = chat.pendingUser.text;
      var found = false;
      for (var i = 0; i < chat.transcript.items.length; i++) {
        var it = chat.transcript.items[i];
        if (it.kind === 'user' && it.text === want) { found = true; break; }
      }
      if (found) chat.pendingUser = null;
    }
    chat.signature = '';
    renderChat(true);
    scrollToBottom(true);
    refreshHeader();
  }

  function handleEvent(value) {
    var chat = state.chat;
    if (!chat || !chat.transcript) return;
    var ev = value && value.event ? value.event : value;
    if (!ev) return;
    chat.transcript.applyEvent(ev);
    if (ev.type === 'user/message' && chat.pendingUser) chat.pendingUser = null;
    chat.title = chat.transcript.title || chat.title;
    chat.running = !!chat.transcript.running;
    scheduleChatRender();
    if (ev.type === 'session/title') refreshHeader();
    if (ev.type === 'turn/end') {
      notifyTurnEnd(ev);
      loadSessions(true);
    }
  }

  function handleAssistantFrame(value) {
    var chat = state.chat;
    if (!chat || !chat.transcript) return;
    var frame = value && value.frame ? value.frame : value;
    if (!frame) return;
    chat.transcript.applyAssistantFrame(frame);
    chat.running = true;
    scheduleChatRender();
  }

  function handleStreamEnd(value) {
    var chat = state.chat;
    if (!chat || !chat.transcript) return;
    if (chat.transcript.applyStreamEnd) {
      chat.transcript.applyStreamEnd(value && value.frame ? value.frame : value);
    }
    chat.running = !!chat.transcript.running;
    scheduleChatRender();
  }

  var renderTimer = null;

  function scheduleChatRender() {
    if (renderTimer) return;
    renderTimer = window.setTimeout(function () {
      renderTimer = null;
      renderChat(false);
    }, 70);
  }

  /* ---------------------------------------------------------------- home */

  function visibleSessions() {
    var current = state.chat && state.chat.sessionId;
    return state.sessions.filter(function (s) {
      if (current && s.id === current) return true;
      return !s.blank;
    }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }

  function renderHome() {
    if (!dom.list) return;
    var items = visibleSessions();
    var rows = items.map(sessionRowHtml).join('');
    dom.list.innerHTML = rows;
    var hasAny = items.length > 0;
    dom.listHead.hidden = !hasAny;
    dom.emptyHome.hidden = hasAny || !!state.listError || !state.sessionsLoaded;

    if (state.listError) {
      dom.list.innerHTML = '<button class="session-item" id="btn-retry-list"><span class="session-avatar">' + icon('refresh') + '</span><span class="session-body"><span class="session-title">加载失败，点击重试</span><span class="session-meta">' + esc(state.listError.message || '网络错误') + '</span></span></button>';
      dom.listHead.hidden = true;
      dom.emptyHome.hidden = true;
    }
    if (dom.brandSub) {
      dom.brandSub.textContent = state.connection === 'connected' ? (location.host || '已连接') : '远程 Agent 客户端';
    }
  }

  function sessionRowHtml(s) {
    var title = s.title || (s.cwd ? basename(s.cwd) : '未命名对话');
    var parts = [];
    if (s.running) parts.push('<span class="session-running"><span class="pulse-dot"></span>运行中</span>');
    if (s.cwd) parts.push('<span class="meta-path">' + esc(basename(s.cwd)) + '</span>');
    parts.push('<span>' + esc(relativeTime(s.updatedAt)) + '</span>');
    var meta = [];
    parts.forEach(function (p, i) { if (i) meta.push('<span class="meta-sep"></span>'); meta.push(p); });
    return '<button class="session-item" data-session="' + esc(s.id) + '" data-running="' + (s.running ? '1' : '0') + '" role="listitem"' + (state.chat && state.chat.sessionId === s.id ? ' data-active="1"' : '') + '>' +
      '<span class="session-avatar">' + icon('message') + '</span>' +
      '<span class="session-body"><span class="session-title">' + esc(title) + '</span><span class="session-meta">' + meta.join('') + '</span></span>' +
      '<svg class="i session-chevron"><use href="#i-chevron"/></svg>' +
      '</button>';
  }

  function uniqueCwds() {
    var seen = {};
    var out = [];
    state.sessions.forEach(function (s) {
      if (!s.cwd || seen[s.cwd]) return;
      seen[s.cwd] = 1;
      out.push(s.cwd);
    });
    var last = storeGet('dsh.lastCwd', '');
    if (last && !seen[last]) { seen[last] = 1; out.unshift(last); }
    return out;
  }

  /* ---------------------------------------------------------------- chat */

  function ensureChat() {
    if (!state.chat) state.chat = newChatState();
    return state.chat;
  }

  function openNewChat(keepScreen) {
    var chat = ensureChat();
    forceUnfollow();
    chat.sessionId = null;
    chat.title = null;
    chat.transcript = null;
    chat.items = [];
    chat.signature = '';
    chat.running = false;
    chat.creating = false;
    chat.hasMore = false;
    chat.cursor = 0;
    chat.streamError = null;
    chat.openReasoning = {};
    chat.openTools = {};
    chat.pendingText = null;
    chat.pendingUser = null;
    chat.cwd = storeGet('dsh.lastCwd', '') || chat.cwd || '';
    chat.model = null;
    resetComposer();
    if (!keepScreen) setScreen('chat');
    renderChat(true);
    refreshHeader();
    updateComposerChips();
    setTimeout(function () { if (dom.input) dom.input.focus(); }, 140);
  }

  function openSession(sessionId) {
    if (state.chat && state.chat.sessionId === sessionId) { setScreen('chat'); return; }
    var meta = null;
    for (var i = 0; i < state.sessions.length; i++) if (state.sessions[i].id === sessionId) meta = state.sessions[i];
    ensureChat();
    var chat = state.chat;
    forceUnfollow();
    chat.sessionId = sessionId;
    chat.title = (meta && meta.title) || null;
    chat.cwd = (meta && meta.cwd) || '';
    chat.model = (meta && meta.model) || null;
    chat.transcript = makeTranscript();
    chat.items = [];
    chat.signature = '';
    chat.running = false;
    chat.hasMore = false;
    chat.cursor = 0;
    chat.loadingOlder = false;
    chat.streamError = null;
    chat.openReasoning = {};
    chat.openTools = {};
    chat.pendingText = null;
    chat.pendingUser = null;
    chat.creating = false;
    setScreen('chat');
    renderChat(true);
    refreshHeader();
    updateComposerChips();
    if (state.client && !state.mock) {
      Promise.resolve(state.client.follow(sessionId)).then(function () {
        /* snapshot arrives through onSnapshot */
      }, function (err) {
        chat.streamError = '无法打开会话：' + ((err && err.message) || '连接失败');
        renderChat(true);
        if (err && err.code && /auth/.test(err.code)) showAuthExpired(err);
      });
    } else if (state.mock) {
      mockFollow(sessionId);
    }
    renderHome();
  }

  function makeTranscript() {
    if (state.mock && window.MockTranscript) return new window.MockTranscript();
    if (window.DSHTranscript) return new window.DSHTranscript();
    if (window.MockTranscript) return new window.MockTranscript();
    return null;
  }

  function forceUnfollow() {
    if (state.client && state.chat && state.chat.sessionId) {
      try { state.client.unfollow(); } catch (e) {}
    }
  }

  function goHome() {
    var chat = state.chat;
    var keepStream = !!(chat && chat.running && state.client && !state.mock);
    if (!keepStream) forceUnfollow();
    setScreen('home');
    renderHome();
    loadSessions(true);
  }

  function refreshHeader() {
    var chat = state.chat;
    if (!chat) return;
    var title = chat.title || (chat.cwd ? basename(chat.cwd) : '');
    if (!title) title = chat.sessionId ? '对话' : '新对话';
    if (dom.chatTitle) dom.chatTitle.textContent = title;
    var modelName = modelDisplay(chat.model);
    if (dom.chatSub) dom.chatSub.textContent = modelName || 'DeepSeek Harness';
    var running = !!(chat.running || chat.creating || chat.sending);
    if (dom.chatStatusDot) dom.chatStatusDot.setAttribute('data-state', running ? 'running' : (state.connection === 'connected' ? 'idle' : 'error'));
    if (dom.btnStop) dom.btnStop.hidden = !chat.running;
    if (dom.runStatus) {
      dom.runStatus.hidden = !chat.running;
      if (chat.running && dom.runStatusText) dom.runStatusText.textContent = '正在生成…';
    }
    updateComposerChips();
    updateSendState();
    syncTaskRunning(running);
  }

  function syncTaskRunning(running) {
    var next = !!running;
    if (window.__dshTaskRunning === next) return;
    window.__dshTaskRunning = next;
    nativeCall('setTaskRunning', next ? 'true' : 'false');
  }

  function notifyTurnEnd(ev) {
    var chat = state.chat;
    if (!chat) return;
    var visible = nativeCall('isAppVisible');
    var background = document.hidden || visible === 'false' || visible === false;
    if (!background && state.screen === 'chat') return;
    var reason = ev && ev.data && ev.data.reason ? ev.data.reason : null;
    var kind = reason && reason.kind ? reason.kind : 'completed';
    var title = kind === 'error' ? 'DSH 任务失败' : (kind === 'cancelled' ? 'DSH 任务已停止' : 'DSH 任务完成');
    var name = chat.title || (chat.cwd ? basename(chat.cwd) : '对话');
    var last = '';
    for (var i = chat.items.length - 1; i >= 0; i--) {
      if (chat.items[i].kind === 'assistant' && chat.items[i].text) { last = chat.items[i].text; break; }
    }
    last = oneLine(last, 70);
    nativeCall('notify', title, name + (last ? '：' + last : ''));
  }

  function modelDisplay(selection) {
    if (!selection) {
      if (state.catalog && state.catalog.default) selection = state.catalog.default;
    }
    if (!selection) return 'deepseek-flash';
    var name = selection.model || '';
    if (state.catalog && state.catalog.groups) {
      for (var i = 0; i < state.catalog.groups.length; i++) {
        var g = state.catalog.groups[i];
        for (var j = 0; j < g.models.length; j++) {
          if (g.models[j].id === selection.model) { name = g.models[j].name || name; }
        }
      }
    }
    return name;
  }

  function updateComposerChips() {
    var chat = state.chat;
    if (!chat || !dom.chips) return;
    var isNew = !chat.sessionId;
    dom.chips.hidden = !isNew;
    dom.chipWorkspace.hidden = !isNew;
    dom.chipModel.hidden = !isNew;
    if (isNew) {
      dom.chipWorkspaceText.textContent = chat.cwd ? basename(chat.cwd) : '选择工作目录';
      dom.chipModelText.textContent = modelDisplay(chat.model);
    }
  }

  /* --------------------------------------------------------- chat render */

  function renderChat(force) {
    var chat = state.chat;
    if (!chat) return;
    if (!dom.messages) return;
    if (dom.welcome) dom.welcome.hidden = !!(chat.items && chat.items.length) || !!chat.sessionId || !!chat.streamError;

    var items = (chat.transcript && chat.transcript.items) ? chat.transcript.items.slice() : [];
    if (chat.pendingUser) items.push({ id: 'pending-user', kind: 'user', text: chat.pendingUser.text });
    chat.items = items;
    if (chat.transcript && typeof chat.transcript.running === 'boolean') chat.running = chat.transcript.running;
    if (chat.transcript && typeof chat.transcript.hasMore === 'boolean') chat.hasMore = chat.transcript.hasMore;

    var sigParts = [];
    var thinking = !!(chat.running && !hasStreamingAssistant(items));
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      sigParts.push(it.id + ':' + it.kind + ':' + (it.kind === 'tool' ? it.status : '') + ':' + (it.kind === 'assistant' ? (it.streaming ? 's' : 'd') : ''));
    }
    sigParts.push('run:' + (thinking ? 1 : 0));
    sigParts.push('err:' + (chat.streamError ? 1 : 0));
    var sig = sigParts.join('|');
    if (!force && sig === chat.signature) {
      updateStreamingNodes();
      refreshHeader();
      return;
    }
    chat.signature = sig;

    if (!items.length && !thinking && !chat.streamError) {
      dom.messages.innerHTML = '';
      if (dom.welcome) dom.welcome.hidden = !!chat.sessionId;
      refreshHeader();
      return;
    }

    var html = '';
    var k = 0;
    while (k < items.length) {
      var it = items[k];
      if (it.kind === 'assistant' || it.kind === 'tool') {
        var group = [it];
        k++;
        while (k < items.length && (items[k].kind === 'assistant' || items[k].kind === 'tool')) {
          group.push(items[k]);
          k++;
        }
        html += groupHtml(group, chat);
        continue;
      }
      html += messageHtml(it, chat);
      k++;
    }
    if (thinking) {
      html += '<div class="thinking-row" data-thinking="1"><span class="thinking-dots"><i></i><i></i><i></i></span><span>正在思考…</span></div>';
    }
    if (chat.streamError) {
      html += '<div class="msg-notice" data-tone="error">' + icon('refresh') + '<span>' + esc(chat.streamError) + '</span></div>';
    }
    dom.messages.innerHTML = html;
    if (dom.btnOlder) dom.btnOlder.hidden = !chat.hasMore;
    if (dom.btnOlder) dom.btnOlder.classList.toggle('is-loading', chat.loadingOlder);
    refreshHeader();
    if (chat.pinned) scrollToBottom(true);
  }

  function hasStreamingAssistant(items) {
    for (var i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'assistant' && items[i].streaming) return true;
    }
    return false;
  }

  function hasStreamingText(items) {
    for (var i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === 'assistant' && items[i].streaming) return !!(items[i].text || items[i].reasoning);
    }
    return false;
  }

  function groupHtml(items, chat) {
    var inner = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind === 'tool') { inner += toolHtml(it, chat); continue; }
      if (it.kind === 'assistant') {
        var empty = !it.text && !it.reasoning && !it.streaming && !it.interrupted;
        if (empty) continue;
        inner += assistantInlineHtml(it, chat);
      }
    }
    if (!inner) return '';
    return '<div class="msg-assistant msg-group">' +
      '<div class="assistant-avatar"><svg class="logo"><use href="#whale"/></svg></div>' +
      '<div class="assistant-body">' + inner + '</div>' +
      '</div>';
  }

  function assistantInlineHtml(item, chat) {
    var open = !!chat.openReasoning[item.id];
    var showReasoning = !!(item.reasoning && item.reasoning.length);
    var activeReasoning = item.streaming && !item.text;
    if (activeReasoning) open = true;
    var reasoning = '';
    if (showReasoning) {
      reasoning = '<div class="reasoning">' +
        '<button class="reasoning-toggle" data-reasoning="' + esc(item.id) + '" data-open="' + (open ? '1' : '0') + '">' +
        icon('chevron') + '<span class="reasoning-label">' + (activeReasoning ? '正在思考…' : '思考过程') + '</span>' +
        '</button>' +
        '<div class="reasoning-body"' + (open ? '' : ' hidden') + '>' + esc(item.reasoning) + '</div>' +
        '</div>';
    }
    var body = '';
    if (item.text) {
      body = item.streaming ? (renderStreamingMarkdown(item.text)) : md(item.text);
    } else if (item.streaming) {
      body = '<span class="thinking-dots"><i></i><i></i><i></i></span>';
    }
    var interrupted = item.interrupted ? '<div class="msg-notice" data-tone="warn">' + icon('stop') + '<span>生成已中断</span></div>' : '';
    return '<div class="group-assistant" data-id="' + esc(item.id) + '">' + reasoning + '<div class="assistant-text md">' + body + '</div>' + interrupted + '</div>';
  }

  function messageHtml(item, chat) {
    if (item.kind === 'user') {
      return '<div class="msg-user" data-id="' + esc(item.id) + '">' + esc(item.text || '').replace(/\n/g, '<br>') + '</div>';
    }
    if (item.kind === 'notice') {
      return '<div class="msg-notice" data-tone="' + esc(item.tone || 'info') + '" data-id="' + esc(item.id) + '">' +
        icon(item.tone === 'error' ? 'close' : 'spark') + '<span>' + esc(item.text || '') + '</span></div>';
    }
    if (item.kind === 'tool') {
      return toolHtml(item, chat);
    }
    if (item.kind === 'assistant') {
      return assistantHtml(item, chat);
    }
    return '';
  }

  function assistantHtml(item, chat) {
    var open = !!chat.openReasoning[item.id];
    var showReasoning = !!(item.reasoning && item.reasoning.length);
    var activeReasoning = item.streaming && !item.text;
    if (activeReasoning) open = true;
    var reasoning = '';
    if (showReasoning) {
      reasoning = '<div class="reasoning">' +
        '<button class="reasoning-toggle" data-reasoning="' + esc(item.id) + '" data-open="' + (open ? '1' : '0') + '">' +
        icon('chevron') + '<span class="reasoning-label">' + (activeReasoning ? '正在思考…' : '思考过程') + '</span>' +
        '</button>' +
        '<div class="reasoning-body"' + (open ? '' : ' hidden') + '>' + esc(item.reasoning) + '</div>' +
        '</div>';
    }
    var body = '';
    if (item.text) {
      body = item.streaming ? (renderStreamingMarkdown(item.text) + '<span class="caret"></span>') : md(item.text);
    } else if (item.streaming) {
      body = '<span class="thinking-dots"><i></i><i></i><i></i></span>';
    }
    var interrupted = item.interrupted ? '<div class="msg-notice" data-tone="warn">' + icon('stop') + '<span>生成已中断</span></div>' : '';
    return '<div class="msg-assistant" data-id="' + esc(item.id) + '">' +
      '<div class="assistant-avatar"><svg class="logo"><use href="#whale"/></svg></div>' +
      '<div class="assistant-body">' + reasoning + '<div class="assistant-text md">' + body + '</div>' + interrupted + '</div>' +
      '</div>';
  }

  function renderStreamingMarkdown(text) {
    // During streaming keep it cheap but still formatted: markdown for short text.
    if (!text) return '';
    var html = text.length > 12000 ? esc(text).replace(/\n/g, '<br>') : md(text);
    var caret = '<span class="caret"></span>';
    var closes = ['</p>', '</li>', '</h4>', '</h3>', '</h2>', '</h1>', '</blockquote>'];
    var at = -1, tagLen = 0;
    for (var i = 0; i < closes.length; i++) {
      var pos = html.lastIndexOf(closes[i]);
      if (pos > at) { at = pos; tagLen = closes[i].length; }
    }
    if (at >= 0) return html.slice(0, at) + caret + html.slice(at);
    return html + caret;
  }

  function toolHtml(item, chat) {
    var open = !!chat.openTools[item.id];
    var status = item.status || 'running';
    var statusIcon = status === 'running' ? '<span class="spinner"></span>' : (status === 'ok' ? icon('check') : icon('close'));
    var iconName = toolIcon(item.name);
    var args = oneLine(item.argsText || '', 110);
    var body = '';
    if (open) {
      var sections = '';
      if (item.argsText) sections += '<div class="tool-section"><div class="tool-section-label">参数</div>' + esc(prettyArgs(item.argsText)) + '</div>';
      if (item.resultText) sections += '<div class="tool-section' + (item.status === 'error' ? ' tool-error-text' : '') + '"><div class="tool-section-label">结果</div>' + esc(item.resultText) + '</div>';
      body = sections || '<div class="tool-section-label">暂无详情</div>';
    }
    return '<div class="msg-tool" data-id="' + esc(item.id) + '" data-status="' + esc(status) + '">' +
      '<button class="tool-head" data-tool="' + esc(item.id) + '" data-open="' + (open ? '1' : '0') + '">' +
      '<span class="tool-icon">' + icon(iconName) + '</span>' +
      '<span class="tool-copy"><span class="tool-name">' + esc(item.name || 'tool') + '</span><span class="tool-args">' + esc(args) + '</span></span>' +
      '<span class="tool-status" data-status="' + esc(status) + '">' + statusIcon + '</span>' +
      '<svg class="i tool-chevron"><use href="#i-chevron"/></svg>' +
      '</button>' +
      '<div class="tool-body"' + (open ? '' : ' hidden') + '>' + body + '</div>' +
      '</div>';
  }

  function toolIcon(name) {
    var n = String(name || '').toLowerCase();
    if (/bash|shell|terminal|pwsh|exec/.test(n)) return 'terminal';
    if (/web|search|fetch|browse/.test(n)) return 'globe';
    if (/file|read|write|edit|glob|grep|patch|list_dir/.test(n)) return 'file';
    if (/present|deliver/.test(n)) return 'spark';
    return 'bolt';
  }

  function updateStreamingNodes() {
    var chat = state.chat;
    if (!chat || !chat.transcript) return;
    var items = chat.transcript.items || [];
    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      if (it.kind !== 'assistant' || !it.streaming) continue;
      var node = dom.messages.querySelector('[data-id="' + cssEscape(it.id) + '"]');
      if (!node) { chat.signature = ''; renderChat(true); return; }
      var textEl = node.querySelector('.assistant-text');
      if (textEl) {
        var html = it.text ? (renderStreamingMarkdown(it.text) + '<span class="caret"></span>') : '<span class="thinking-dots"><i></i><i></i><i></i></span>';
        if (textEl.innerHTML !== html) textEl.innerHTML = html;
      }
      var reasonEl = node.querySelector('.reasoning-body');
      if (reasonEl && it.reasoning) {
        var rText = it.reasoning;
        if (reasonEl.textContent !== rText) reasonEl.textContent = rText;
      }
      var toggle = node.querySelector('.reasoning-toggle');
      if (toggle) {
        var active = !it.text;
        var open = chat.openReasoning[it.id] || active;
        toggle.setAttribute('data-open', open ? '1' : '0');
        var label = toggle.querySelector('.reasoning-label');
        if (label) label.textContent = active ? '正在思考…' : '思考过程';
        if (reasonEl) reasonEl.hidden = !open;
      }
      break;
    }
    if (chat.pinned) scrollToBottom();
    refreshHeader();
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(String(s));
    return String(s).replace(/["\\]/g, '\\$&');
  }

  /* ------------------------------------------------------------- scrolling */

  function scrollToBottom(instant) {
    if (!dom.chatScroll) return;
    var el = dom.chatScroll;
    el.scrollTop = el.scrollHeight;
    if (!instant) return;
    updateJump(false);
  }

  function nearBottom() {
    var el = dom.chatScroll;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }

  function updateJump(show) {
    if (dom.jump) dom.jump.hidden = !show;
  }

  /* ------------------------------------------------------------- composer */

  function resetComposer() {
    if (dom.input) { dom.input.value = ''; autoResize(); }
    updateSendState();
  }

  function autoResize() {
    var el = dom.input;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }

  function updateSendState() {
    if (!dom.send) return;
    var chat = state.chat;
    var text = dom.input ? dom.input.value.trim() : '';
    var busy = chat && chat.creating;
    dom.send.disabled = !text || !!busy;
    if (dom.composer) dom.composer.classList.toggle('is-disabled', !!busy);
  }

  function setInputText(text) {
    if (!dom.input) return;
    dom.input.value = text;
    autoResize();
    updateSendState();
    dom.input.focus();
  }

  function sendFromComposer() {
    var chat = ensureChat();
    var text = dom.input ? dom.input.value.trim() : '';
    if (!text || chat.creating) return;
    if (!chat.sessionId && !chat.cwd) {
      openWorkspaceSheet(function () { setInputText(text); sendFromComposer(); });
      return;
    }
    dom.input.value = '';
    autoResize();
    updateSendState();
    chat.pinned = true;
    doSend(text);
  }

  async function doSend(text) {
    var chat = ensureChat();
    if (!state.client || state.mock) {
      if (state.mock) { mockSend(text); return; }
      toast('客户端未就绪');
      return;
    }
    chat.pendingUser = { text: text };
    chat.pinned = true;
    renderChat(true);
    try {
      if (!chat.sessionId) {
        chat.creating = true;
        refreshHeader();
        var cwd = chat.cwd || DEFAULT_CWD;
        var created = await state.client.createSession({ cwd: cwd });
        chat.sessionId = (created && created.sessionId) || (created && created.value && created.value.sessionId);
        if (!chat.sessionId) throw new Error('创建会话失败');
        storeSet('dsh.lastCwd', cwd);
        if (chat.model) {
          try { await state.client.selectModel(chat.sessionId, chat.model); } catch (e) { /* model selection is best-effort */ }
        }
        await state.client.follow(chat.sessionId);
        chat.creating = false;
        chat.transcript = chat.transcript || makeTranscript();
        if (chat.transcript && chat.transcript.reset) chat.transcript.reset({ type: 'snapshot', header: {}, cursor: 0, records: [], hasMore: false, projections: { asOfSeq: 0, values: {} } });
        refreshHeader();
        updateComposerChips();
        renderChat(true);
        loadSessions(true);
      }
      chat.sending = true;
      refreshHeader();
      await state.client.sendPrompt(chat.sessionId, text, { mode: 'queue' });
      chat.pendingText = null;
      chat.sending = false;
      refreshHeader();
      scrollToBottom();
    } catch (err) {
      chat.creating = false;
      chat.sending = false;
      chat.pendingUser = null;
      renderChat(true);
      refreshHeader();
      var msg = (err && err.message) || '发送失败';
      if (err && err.code && /auth|token|credential/i.test(err.code)) {
        showAuthExpired(err);
      } else {
        toast(msg);
      }
      if (dom.input && !dom.input.value) setInputText(text);
    }
  }

  function stopGeneration() {
    var chat = state.chat;
    if (!chat || !chat.sessionId) return;
    if (state.client && !state.mock) {
      Promise.resolve(state.client.cancel(chat.sessionId)).then(function () {
        toast('已请求停止');
      }, function (err) { toast((err && err.message) || '停止失败'); });
    } else if (state.mock) {
      mockStop();
    }
  }

  async function loadOlder() {
    var chat = state.chat;
    if (!chat || !chat.sessionId || !chat.hasMore || chat.loadingOlder) return;
    if (!state.client || state.mock) return;
    chat.loadingOlder = true;
    if (dom.btnOlder) dom.btnOlder.classList.add('is-loading');
    var firstSeq = 0;
    var items = chat.transcript ? chat.transcript.items : [];
    for (var i = 0; i < items.length; i++) { if (typeof items[i].seq === 'number') { firstSeq = items[i].seq; break; } }
    var el = dom.chatScroll;
    var prevHeight = el.scrollHeight;
    var prevTop = el.scrollTop;
    try {
      var res = await state.client.pageOlder(chat.sessionId, { throughSeq: chat.cursor, beforeSeq: firstSeq || undefined, maxMessages: 30 });
      if (res && res.records && chat.transcript && chat.transcript.prependRecords) {
        chat.transcript.prependRecords(res.records, !!res.hasMore);
      }
      chat.hasMore = !!(res && res.hasMore);
      chat.signature = '';
      renderChat(true);
      el.scrollTop = el.scrollHeight - prevHeight + prevTop;
    } catch (err) {
      toast((err && err.message) || '加载失败');
    } finally {
      chat.loadingOlder = false;
      if (dom.btnOlder) dom.btnOlder.classList.remove('is-loading');
      renderChat(true);
    }
  }

  /* --------------------------------------------------------------- sheets */

  function openSheet(html, opts) {
    if (!dom.sheetLayer) return;
    opts = opts || {};
    dom.sheet.innerHTML = html;
    dom.sheetLayer.hidden = false;
    state.sheetOpen = true;
    if (opts.onMount) opts.onMount(dom.sheet);
    if (opts.dialog) { /* wide screens center the sheet automatically */ }
  }

  function closeSheet() {
    if (!dom.sheetLayer) return;
    dom.sheetLayer.hidden = true;
    dom.sheet.innerHTML = '';
    state.sheetOpen = false;
  }

  function sheetHeader(title, sub) {
    return '<div class="sheet-handle"></div><div class="sheet-title">' + esc(title) + '</div>' + (sub ? '<div class="sheet-sub">' + esc(sub) + '</div>' : '');
  }

  function openMenuSheet() {
    var chat = state.chat;
    if (!chat) return;
    var html = sheetHeader('对话操作') +
      '<div class="sheet-list">' +
      '<button class="sheet-item" data-action="rename"><span class="sheet-item-icon">' + icon('file') + '</span><span class="sheet-item-copy"><span class="sheet-item-title">重命名对话</span></span></button>' +
      '<button class="sheet-item" data-action="model"><span class="sheet-item-icon">' + icon('chip') + '</span><span class="sheet-item-copy"><span class="sheet-item-title">选择模型</span><span class="sheet-item-sub">' + esc(modelDisplay(chat.model)) + '</span></span></button>' +
      (chat.cwd ? '<button class="sheet-item" data-action="cwd"><span class="sheet-item-icon">' + icon('folder') + '</span><span class="sheet-item-copy"><span class="sheet-item-title">工作目录</span><span class="sheet-item-sub">' + esc(chat.cwd) + '</span></span></button>' : '') +
      (chat.running ? '<button class="sheet-item" data-action="stop"><span class="sheet-item-icon">' + icon('stop') + '</span><span class="sheet-item-copy"><span class="sheet-item-title">停止生成</span></span></button>' : '') +
      '</div>';
    openSheet(html, {
      onMount: function (root) {
        $all('[data-action]', root).forEach(function (el) {
          el.addEventListener('click', function () {
            var a = el.getAttribute('data-action');
            if (a === 'rename') { closeSheet(); openRenameSheet(); }
            else if (a === 'model') { closeSheet(); openModelSheet(); }
            else if (a === 'cwd') { closeSheet(); toast(chat.cwd, 3200); }
            else if (a === 'stop') { closeSheet(); stopGeneration(); }
          });
        });
      }
    });
  }

  function openRenameSheet() {
    var chat = state.chat;
    var current = (chat.title || '').replace(/"/g, '&quot;');
    var html = sheetHeader('重命名对话') +
      '<input class="field" id="rename-input" maxlength="120" placeholder="给这个对话起个名字" value="' + current + '" />' +
      '<div class="dialog-actions"><button class="btn btn-ghost" id="rename-cancel">取消</button><button class="btn btn-primary" id="rename-save">保存</button></div>';
    openSheet(html, {
      onMount: function (root) {
        var input = $('#rename-input', root);
        input.focus();
        function save() {
          var title = input.value.trim();
          if (!title) { toast('标题不能为空'); return; }
          closeSheet();
          if (state.client && chat.sessionId) {
            Promise.resolve(state.client.renameSession(chat.sessionId, title)).then(function () {
              chat.title = title;
              refreshHeader();
              renderHome();
              toast('已重命名');
            }, function (err) { toast((err && err.message) || '重命名失败'); });
          } else {
            toast('新对话还没有创建，先发送一条消息吧');
          }
        }
        $('#rename-save', root).addEventListener('click', save);
        $('#rename-cancel', root).addEventListener('click', closeSheet);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); save(); } });
      }
    });
  }

  function openWorkspaceSheet(then) {
    var recent = uniqueCwds();
    var listHtml = recent.length
      ? recent.map(function (p) {
          return '<button class="sheet-item" data-cwd="' + esc(p) + '"><span class="sheet-item-icon">' + icon('folder') + '</span><span class="sheet-item-copy"><span class="sheet-item-title">' + esc(basename(p)) + '</span><span class="sheet-item-sub">' + esc(p) + '</span></span><span class="sheet-check" hidden>' + icon('check') + '</span></button>';
        }).join('')
      : '<div class="settings-note">还没有使用过的目录，输入一个绝对路径开始。</div>';
    var html = sheetHeader('选择工作目录', 'DSH 会在这个目录里读写文件、运行命令。') +
      '<div class="sheet-list">' + listHtml + '</div>' +
      '<label class="field-label">目录路径</label>' +
      '<input class="field" id="ws-input" placeholder="/root/我的项目" value="' + esc(state.chat ? state.chat.cwd : '') + '" />' +
      '<div class="dialog-actions"><button class="btn btn-ghost" id="ws-cancel">取消</button><button class="btn btn-primary" id="ws-ok">确定</button></div>';
    openSheet(html, {
      onMount: function (root) {
        var input = $('#ws-input', root);
        function selectActive() {
          $all('[data-cwd]', root).forEach(function (el) { el.setAttribute('data-active', el.getAttribute('data-cwd') === input.value ? '1' : '0'); });
        }
        selectActive();
        $all('[data-cwd]', root).forEach(function (el) {
          el.addEventListener('click', function () {
            input.value = el.getAttribute('data-cwd');
            selectActive();
          });
        });
        $('#ws-cancel', root).addEventListener('click', function () { closeSheet(); if (then) then(true); });
        $('#ws-ok', root).addEventListener('click', function () {
          var p = input.value.trim();
          if (!p || p.charAt(0) !== '/') { toast('请输入以 / 开头的绝对路径'); return; }
          if (state.chat) state.chat.cwd = p.replace(/\/+$/, '');
          storeSet('dsh.lastCwd', state.chat ? state.chat.cwd : p);
          closeSheet();
          updateComposerChips();
          if (then) then();
        });
      }
    });
  }

  async function openModelSheet() {
    if (!state.client || state.mock) { if (state.mock) return mockModelSheet(); toast('模型列表不可用'); return; }
    var chat = state.chat;
    openSheet(sheetHeader('选择模型') + '<div class="settings-note">正在加载模型列表…</div>');
    try {
      if (!state.catalog || Date.now() - state.catalogAt > 60000) {
        var cat = await state.client.modelCatalog();
        state.catalog = cat || state.catalog;
        state.catalogAt = Date.now();
      }
      renderModelSheet();
    } catch (err) {
      openSheet(sheetHeader('选择模型') + '<div class="settings-note">加载失败：' + esc((err && err.message) || '未知错误') + '</div>');
    }
  }

  function renderModelSheet(currentModelId) {
    var cat = state.catalog;
    var chat = state.chat;
    if (!cat || !cat.groups) { openSheet(sheetHeader('选择模型') + '<div class="settings-note">没有可用的模型。</div>'); return; }
    var selected = chat.model || cat.default || {};
    var groupsHtml = cat.groups.map(function (g) {
      var models = (g.models || []).map(function (m) {
        var active = selected.model === m.id && (!selected.provider || selected.provider === g.id);
        var efforts = m.reasoning && m.reasoning.efforts && m.reasoning.efforts.length;
        return '<button class="sheet-item" data-model="' + esc(m.id) + '" data-provider="' + esc(g.id) + '" data-active="' + (active ? '1' : '0') + '">' +
          '<span class="sheet-item-icon">' + icon('chip') + '</span>' +
          '<span class="sheet-item-copy"><span class="sheet-item-title">' + esc(m.name || m.id) + '</span><span class="sheet-item-sub">' + esc(g.name || g.id) + (m.description ? ' · ' + esc(oneLine(m.description, 40)) : '') + (efforts ? ' · 支持推理强度' : '') + '</span></span>' +
          '<span class="sheet-check"' + (active ? '' : ' hidden') + '>' + icon('check') + '</span>' +
          '</button>';
      }).join('');
      return '<div class="settings-group-title">' + esc(g.name || g.id) + '</div>' + models;
    }).join('');
    openSheet(sheetHeader('选择模型', '仅影响当前对话。') + '<div class="sheet-list">' + groupsHtml + '</div>', {
      onMount: function (root) {
        $all('[data-model]', root).forEach(function (el) {
          el.addEventListener('click', function () {
            var provider = el.getAttribute('data-provider');
            var modelId = el.getAttribute('data-model');
            var model = findModel(provider, modelId);
            if (model && model.reasoning && model.reasoning.efforts && model.reasoning.efforts.length) {
              renderEffortSheet(provider, model);
            } else {
              applyModel({ provider: provider, model: modelId });
            }
          });
        });
      }
    });
  }

  function findModel(provider, modelId) {
    var cat = state.catalog;
    if (!cat || !cat.groups) return null;
    for (var i = 0; i < cat.groups.length; i++) {
      var g = cat.groups[i];
      if (g.id !== provider) continue;
      for (var j = 0; j < g.models.length; j++) if (g.models[j].id === modelId) return g.models[j];
    }
    return null;
  }

  function renderEffortSheet(provider, model) {
    var efforts = model.reasoning.efforts || [];
    var current = state.chat.model && state.chat.model.model === model.id ? (state.chat.model.reasoningEffort || '') : (model.reasoning.defaultEffort || '');
    var rows = efforts.map(function (e) {
      return '<button class="sheet-item" data-effort="' + esc(e.id) + '" data-active="' + (current === e.id ? '1' : '0') + '">' +
        '<span class="sheet-item-icon">' + icon('bolt') + '</span>' +
        '<span class="sheet-item-copy"><span class="sheet-item-title">' + esc(e.name || e.id) + '</span>' + (e.description ? '<span class="sheet-item-sub">' + esc(e.description) + '</span>' : '') + '</span>' +
        '<span class="sheet-check"' + (current === e.id ? '' : ' hidden') + '>' + icon('check') + '</span></button>';
    }).join('');
    openSheet(sheetHeader('推理强度', model.name || model.id) + '<div class="sheet-list">' + rows + '</div>', {
      onMount: function (root) {
        $all('[data-effort]', root).forEach(function (el) {
          el.addEventListener('click', function () {
            applyModel({ provider: provider, model: model.id, reasoningEffort: el.getAttribute('data-effort') });
          });
        });
      }
    });
  }

  function applyModel(selection) {
    var chat = state.chat;
    if (!chat) return;
    chat.model = selection;
    closeSheet();
    refreshHeader();
    updateComposerChips();
    if (state.client && !state.mock && chat.sessionId) {
      Promise.resolve(state.client.selectModel(chat.sessionId, selection)).then(function () {
        toast('已切换模型');
      }, function (err) { toast((err && err.message) || '切换模型失败'); });
    } else {
      toast('新对话将使用 ' + modelDisplay(selection));
    }
  }

  /* -------------------------------------------------------------- settings */

  function openSettings() {
    setScreen('settings');
    renderSettings();
  }

  function renderSettings() {
    if (!dom.settingsBody) return;
    var connMap = { connecting: '连接中', connected: '已连接', reconnecting: '重连中', offline: '未连接' };
    var base = location.origin;
    var appVersion = nativeCall('appVersion') || '0.1.0';
    var html =
      '<div class="settings-group"><div class="settings-group-title">连接</div><div class="settings-card">' +
      '<div class="settings-row"><span class="settings-row-label">服务器</span><span class="settings-row-value">' + esc(base) + '</span></div>' +
      '<div class="settings-row"><span class="settings-row-label">状态</span><span class="settings-row-value">' + esc(connMap[state.connection] || state.connection) + '</span></div>' +
      '<button class="settings-row" id="set-reconnect"><span class="settings-row-label" style="color:var(--accent)">重新连接</span><span class="settings-row-value">›</span></button>' +
      '</div><div class="settings-note">令牌由系统安全存储，不会显示在这里。连接失败时请回到电脑上查看 <span class="settings-row-value" style="display:inline">dsh web</span> 打印的新链接。</div></div>' +
      '<div class="settings-group"><div class="settings-group-title">会话</div><div class="settings-card">' +
      '<button class="settings-row" id="set-refresh"><span class="settings-row-label">立即刷新会话列表</span><span class="settings-row-value">' + state.sessions.length + ' 个</span></button>' +
      '<button class="settings-row settings-row-danger" id="set-reset"><span class="settings-row-label">更换服务器 / 重新登录</span><span class="settings-row-value">›</span></button>' +
      '</div><div class="settings-note">重新登录会清除本机保存的地址与令牌，需要重新粘贴 dsh web 的链接。</div></div>' +
      '<div class="settings-group"><div class="settings-group-title">关于</div><div class="settings-card">' +
      '<div class="settings-row"><span class="settings-row-label">DSH Mobile</span><span class="settings-row-value">' + esc(appVersion) + '</span></div>' +
      '<div class="settings-row"><span class="settings-row-label">DeepSeek Harness</span><span class="settings-row-value">0.2.1-rc.2</span></div>' +
      '</div><div class="settings-about">为 DeepSeek Harness 打造的轻量 Android 客户端<br>会话、流式回复与工具调用状态</div></div>';
    dom.settingsBody.innerHTML = html;
    var reconnect = $('#set-reconnect');
    if (reconnect) reconnect.addEventListener('click', function () {
      if (state.client) { try { state.client.connect(); } catch (e) {} toast('正在重新连接…'); }
    });
    var refresh = $('#set-refresh');
    if (refresh) refresh.addEventListener('click', function () { loadSessions(); toast('正在刷新…'); });
    var reset = $('#set-reset');
    if (reset) reset.addEventListener('click', function () {
      var ok = nativeCall('reset');
      if (ok === null) toast('请在 App 中操作');
    });
  }

  /* --------------------------------------------------------------- screens */

  function setScreen(screen) {
    state.screen = screen;
    var wide = state.wide;
    if (!dom.home) return;
    if (wide) {
      dom.home.hidden = false;
      dom.chat.hidden = false;
      dom.settings.hidden = screen !== 'settings';
    } else {
      dom.home.hidden = screen !== 'home';
      dom.chat.hidden = screen !== 'chat';
      dom.settings.hidden = screen !== 'settings';
    }
    if (screen === 'home' && !wide) loadSessions(true);
    if (screen === 'chat') setTimeout(function () { if (state.chat && state.chat.pinned) scrollToBottom(true); }, 30);
  }

  function setupWide() {
    var mq = window.matchMedia('(min-width: 780px) and (min-aspect-ratio: 1/1)');
    function apply() {
      state.wide = mq.matches;
      dom.app.classList.toggle('is-wide', state.wide);
      if (state.chat) { setScreen(state.screen); }
    }
    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
  }

  /* --------------------------------------------------------------- toasts */

  function toast(msg, ms) {
    if (!dom.toast) return;
    dom.toast.textContent = String(msg || '');
    dom.toast.hidden = false;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { dom.toast.hidden = true; }, ms || 2200);
  }

  function showAuthExpired(err) {
    openSheet(sheetHeader('连接已失效', '令牌可能已经过期，或服务器地址已变更。请重新粘贴 dsh web 打印的链接。') +
      '<div class="dialog-actions"><button class="btn btn-ghost" id="auth-retry">重试</button><button class="btn btn-primary" id="auth-reset">重新登录</button></div>', {
      onMount: function (root) {
        $('#auth-retry', root).addEventListener('click', function () { closeSheet(); if (state.client) { try { state.client.connect(); } catch (e) {} } });
        $('#auth-reset', root).addEventListener('click', function () {
          closeSheet();
          if (nativeCall('reset') === null) toast('请在 App 中重新登录');
        });
      }
    });
  }

  /* --------------------------------------------------------------- events */

  function bindGlobalEvents() {
    dom.btnNewChat.addEventListener('click', function () { openNewChat(); });
    var emptyNew = $('#btn-empty-new');
    if (emptyNew) emptyNew.addEventListener('click', function () { openNewChat(); });
    $('#btn-refresh').addEventListener('click', function () { loadSessions(); });
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-settings-back').addEventListener('click', function () { setScreen(state.wide && state.chat && state.chat.sessionId ? 'chat' : (state.wide ? 'chat' : 'home')); renderHome(); });
    $('#btn-chat-back').addEventListener('click', goHome);
    $('#btn-chat-menu').addEventListener('click', openMenuSheet);
    $('#btn-chat-model').addEventListener('click', openModelSheet);
    $('#btn-chat-stop').addEventListener('click', stopGeneration);
    $('#btn-stop-inline').addEventListener('click', stopGeneration);
    $('#btn-jump').addEventListener('click', function () { state.chat.pinned = true; scrollToBottom(); updateJump(false); });
    dom.btnOlder.addEventListener('click', loadOlder);
    dom.send.addEventListener('click', sendFromComposer);
    dom.input.addEventListener('input', function () { autoResize(); updateSendState(); });
    dom.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !IS_TOUCH && !e.isComposing) { e.preventDefault(); sendFromComposer(); }
    });
    dom.chipWorkspace.addEventListener('click', function () { openWorkspaceSheet(); });
    dom.chipModel.addEventListener('click', openModelSheet);

    dom.list.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('[data-session]') : null;
      if (item) { openSession(item.getAttribute('data-session')); return; }
      if (e.target.closest && e.target.closest('#btn-retry-list')) { state.listError = null; renderHome(); loadSessions(); }
    });

    dom.messages.addEventListener('click', function (e) {
      var toggle = e.target.closest ? e.target.closest('[data-tool]') : null;
      if (toggle) {
        var id = toggle.getAttribute('data-tool');
        var chat = state.chat;
        chat.openTools[id] = !chat.openTools[id];
        chat.signature = '';
        renderChat(true);
        return;
      }
      var rt = e.target.closest ? e.target.closest('[data-reasoning]') : null;
      if (rt) {
        var rid = rt.getAttribute('data-reasoning');
        var c = state.chat;
        c.openReasoning[rid] = !c.openReasoning[rid];
        c.signature = '';
        renderChat(true);
      }
    });

    dom.chatScroll.addEventListener('click', function (e) {
      var sug = e.target.closest ? e.target.closest('[data-suggest]') : null;
      if (sug) { setInputText(sug.getAttribute('data-suggest')); return; }
      var a = e.target.closest ? e.target.closest('a[href]') : null;
      if (a && /^https?:/.test(a.getAttribute('href') || '')) {
        if (nativeCall('openExternal', a.href) !== null) e.preventDefault();
      }
    });

    window.addEventListener('resize', function () {
      if (state.chat && state.chat.pinned) setTimeout(function () { scrollToBottom(true); }, 120);
    });

    dom.chatScroll.addEventListener('scroll', function () {
      var chat = state.chat;
      if (!chat) return;
      var near = nearBottom();
      chat.pinned = near;
      updateJump(!near);
      if (dom.chatScroll.scrollTop < 36 && chat.hasMore && !chat.loadingOlder) loadOlder();
    });

    dom.sheetLayer.addEventListener('click', function (e) {
      if (e.target === dom.sheetLayer || e.target.id === 'sheet-backdrop') closeSheet();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (state.sheetOpen) closeSheet();
      }
    });

    window.DSH_onBack = function () {
      if (state.sheetOpen) { closeSheet(); return true; }
      if (state.screen === 'settings') { setScreen(state.wide ? 'chat' : (state.chat && state.chat.sessionId ? 'chat' : 'home')); return true; }
      if (state.screen === 'chat' && !state.wide) { goHome(); return true; }
      return false;
    };
    window.DSH_onResume = function () {
      if (state.connection === 'offline' && state.client) { try { state.client.connect(); } catch (e) {} }
      if (state.screen === 'home' || state.wide) loadSessions(true);
      if (state.chat && state.chat.sessionId) scrollToBottom(true);
    };
  }

  /* ------------------------------------------------------- mock transcript */
  /* Dev-only transcript used when the page is opened with ?mock=1 (or when
     web/api.js is unavailable). It imitates the real DSHTranscript API. */
  function MockTranscript() {
    this.items = [];
    this.title = null;
    this.running = false;
    this.hasMore = false;
    this.cursor = 0;
    this._timer = null;
  }
  window.MockTranscript = MockTranscript;
  MockTranscript.prototype.reset = function () { this.items = []; };
  MockTranscript.prototype.applyEvent = function () {};
  MockTranscript.prototype.applyAssistantFrame = function () {};
  MockTranscript.prototype.applyStreamEnd = function () {};
  MockTranscript.prototype.prependRecords = function () {};
  MockTranscript.prototype._push = function (item) { this.items.push(item); };
  MockTranscript.prototype.seedDemo = function (title) {
    this.items = [];
    this.title = title || '演示对话';
    this.hasMore = true;
    this.cursor = 42;
    this._push({ id: 'm-u1', kind: 'user', text: '帮我看看登录接口为什么偶尔会超时，顺便把超时时间调大一点。', seq: 2 });
    this._push({
      id: 'm-a1', kind: 'assistant', seq: 3,
      reasoning: '先定位登录接口的超时来源：查看 server/routes/auth.ts 与上游请求封装，再检查最近的改动。如果只是上游响应慢，把超时从 8s 调到 20s 并加上重试即可。',
      text: '我先定位一下超时的来源。\n\n- 检查 `server/routes/auth.ts` 中调用上游的部分\n- 看看最近一次提交是否改了超时配置\n- 顺手跑一遍测试',
      streaming: false
    });
    this._push({
      id: 'm-t1', kind: 'tool', callId: 'call-1', name: 'bash', status: 'ok', seq: 6,
      argsText: '{"description":"查找超时配置","command":"grep -rn \\"timeout\\" server/ | head -20"}',
      resultText: 'server/routes/auth.ts:42:  timeout: 8000,\nserver/lib/http.ts:17:  timeout = 8000,\nserver/lib/http.ts:58:  throw new Error("upstream timeout after " + timeout + "ms")'
    });
    this._push({
      id: 'm-t2', kind: 'tool', callId: 'call-2', name: 'read_file', status: 'ok', seq: 9,
      argsText: '{"path":"server/routes/auth.ts"}',
      resultText: 'import { postJson } from "../lib/http"\n\nexport async function login(req, res) {\n  const upstream = await postJson(process.env.AUTH_URL + "/login", {\n    body: req.body,\n    timeout: 8000,\n  })\n  res.json(upstream)\n}'
    });
    this._push({
      id: 'm-a2', kind: 'assistant', seq: 12,
      reasoning: '',
      text: '问题找到了：`server/routes/auth.ts` 里上游调用写死了 `timeout: 8000`，而登录上游最近在高峰期会排队到 10 秒以上。\n\n改成 20 秒，并在 `lib/http.ts` 里补一次针对超时的重试：\n\n```ts\nconst upstream = await postJson(AUTH_URL + "/login", {\n  body: req.body,\n  timeout: 20000,\n  retryOnTimeout: 1,\n})\n```\n\n需要我直接改到工作区里吗？',
      streaming: false
    });
    this._push({ id: 'm-n1', kind: 'notice', tone: 'info', text: '演示会话 · 数据为本地模拟', seq: 13 });
  };
  MockTranscript.prototype.mockPrompt = function (text) {
    var self = this;
    this.items.push({ id: 'm-u' + Date.now(), kind: 'user', text: text, seq: this.cursor++ });
    var aid = 'm-a' + Date.now();
    var attempt = { id: aid, kind: 'assistant', text: '', reasoning: '', streaming: true, seq: undefined };
    this.items.push(attempt);
    this.running = true;
    var chunks = [
      { reasoning: '先读一下用户说的内容，然后检查工作目录里相关的文件。' },
      { reasoning: '目录结构看起来是一个 Node 项目，先看 package.json 和 README。' },
      { text: '我先看一下项目结构。\n\n' },
      { text: '当前目录是一个 **Node.js** 项目，依赖里包含 `express` 和 `vitest`。\n\n' },
      { text: '```bash\nnpm install\nnpm test\n```\n' },
      { text: '\n接下来我会运行测试，看有没有失败项。' }
    ];
    var i = 0;
    this._timer = setInterval(function () {
      if (i >= chunks.length) {
        clearInterval(self._timer);
        self._timer = null;
        attempt.streaming = false;
        attempt.seq = self.cursor++;
        self.running = false;
        self.items.push({
          id: 'm-t' + Date.now(), kind: 'tool', callId: 'call-' + Date.now(), name: 'bash', status: 'ok', seq: self.cursor++,
          argsText: '{"description":"运行测试","command":"npm test -- --run"}',
          resultText: 'RUN  v1.6.0 /root/demo\n\n ✓ test/auth.test.ts (4 tests)\n ✓ test/http.test.ts (2 tests)\n\n Test Files  2 passed (2)\n      Tests  6 passed (6)'
        });
        self.items.push({ id: 'm-a-end' + Date.now(), kind: 'assistant', reasoning: '', text: '测试全部通过 ✅ 需要我继续做点别的吗？', streaming: false, seq: self.cursor++ });
        if (window.__onMockUpdate) window.__onMockUpdate();
        return;
      }
      var c = chunks[i++];
      if (c.reasoning) attempt.reasoning += c.reasoning;
      if (c.text) attempt.text += c.text;
      if (window.__onMockUpdate) window.__onMockUpdate();
    }, 420);
  };
  MockTranscript.prototype.mockStop = function () {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.running = false;
    for (var i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].kind === 'assistant' && this.items[i].streaming) { this.items[i].streaming = false; this.items[i].interrupted = true; break; }
    }
    if (window.__onMockUpdate) window.__onMockUpdate();
  };

  /* ----------------------------------------------------------------- mock */

  function initMock() {
    state.mock = true;
    state.connection = 'connected';
    state.sessions = [
      mockSession('session-demo-1', '修复登录接口的超时问题', '/root/webprinter', 1792814000000, false, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }),
      mockSession('session-demo-2', '把项目里的 Express 路由迁移到 Fastify', '/root/api-server', 1792809000000, true, { provider: 'deepseek-official', model: 'deepseek-flash' }),
      mockSession('session-demo-3', '写一份部署说明并检查 systemd 配置', '/root/DSH-Client', 1792790000000, false, { provider: 'deepseek-official', model: 'deepseek-flash' }),
      mockSession('session-demo-4', '分析昨天的构建失败日志', '/root/webprinter', 1792700000000, false, { provider: 'deepseek-official', model: 'deepseek-flash' })
    ];
    state.sessionsLoaded = true;
    state.listLoading = false;
    state.catalog = {
      default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek 官方', models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash', description: '快速、通用', reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'medium', name: '中' }, { id: 'low', name: '低' }], defaultEffort: 'high' } },
          { id: 'deepseek-v4', name: 'DeepSeek V4', description: '最强推理' }
        ] },
        { id: 'robot-ollama', name: 'Robot Local Ollama', models: [{ id: 'qwen3:0.6b', name: 'Qwen3 0.6B' }] }
      ]
    };
    state.chat = null;
  }

  function mockSession(id, title, cwd, updatedAt, running, model) {
    return { id: id, title: title, cwd: cwd, running: running, updatedAt: updatedAt, blank: false, model: model, tokens: null };
  }

  function mockFollow(sessionId) {
    var chat = ensureChat();
    var s = null;
    state.sessions.forEach(function (x) { if (x.id === sessionId) s = x; });
    chat.title = s ? s.title : chat.title;
    refreshHeader();
    var t = chat.transcript;
    if (!t) {
      t = window.MockTranscript ? new window.MockTranscript() : null;
      chat.transcript = t;
    }
    if (!t) return;
    window.__onMockUpdate = function () { chat.signature = ''; renderChat(true); if (chat.pinned) scrollToBottom(); };
    if (t.seedDemo) t.seedDemo(s ? s.title : '演示对话');
    chat.items = t.items;
    chat.running = false;
    chat.hasMore = true;
    chat.signature = '';
    renderChat(true);
    scrollToBottom(true);
  }

  function mockSend(text) {
    var chat = ensureChat();
    if (!state.chat.sessionId) {
      chat.sessionId = 'session-mock-' + Date.now();
      chat.transcript = window.MockTranscript ? new window.MockTranscript() : null;
      chat.title = '演示：' + oneLine(text, 12);
      refreshHeader();
      updateComposerChips();
    }
    if (!chat.transcript) return;
    window.__onMockUpdate = function () { chat.signature = ''; renderChat(true); if (chat.pinned) scrollToBottom(); };
    chat.transcript.mockPrompt(text);
    chat.pinned = true;
    renderChat(true);
  }

  function mockStop() {
    if (state.chat && state.chat.transcript && state.chat.transcript.mockStop) state.chat.transcript.mockStop();
    renderChat(true);
  }

  function mockModelSheet() {
    renderModelSheet();
  }

  /* ---------------------------------------------------------------- start */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
