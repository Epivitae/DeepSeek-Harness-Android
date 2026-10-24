#!/usr/bin/env node
// DSH client dev proxy.
//
// Serves /root/DSH-Client/web/ as same-origin static files and proxies
// /api/* unary RPCs plus the /api/remote.mux WebSocket to the live DSH web
// server with the auth cookie injected server-side (exactly like production,
// where the WebView is loaded with loadDataWithBaseURL after native auth and
// the cookie is in the CookieManager).
//
// Usage: node tools/dev-proxy.mjs [--port 8099] [--root /root/DSH-Client/web]
//                                [--upstream http://127.0.0.1:3080]
//
// The auth token is read from $DSH_TOKEN_FILE (default: ~/.dsh-token; format:
// http://127.0.0.1:3080/?token=...). The token can rotate when dsh-web
// restarts; the proxy re-reads + re-exchanges it automatically when the
// upstream answers 401 or the WS handshake is rejected.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf('--' + name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const kv = args.find((a) => a.startsWith('--' + name + '='));
  if (kv) return kv.slice(name.length + 3);
  return fallback;
}

const PORT = Number(argValue('port', process.env.DEV_PROXY_PORT || 8099));
const ROOT = path.resolve(argValue('root', path.join(REPO, 'web')));
const TOKEN_FILE = argValue('token-file', process.env.DSH_TOKEN_FILE || ((process.env.HOME || '.') + '/.dsh-token'));
const UPSTREAM = new URL(argValue('upstream', 'http://127.0.0.1:3080'));
const UPSTREAM_HOST = UPSTREAM.hostname;
const UPSTREAM_PORT = Number(UPSTREAM.port || 80);
const LOG = (...a) => console.log(new Date().toISOString(), ...a);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Auth: token -> cookie, cached, refreshed on demand.
// ---------------------------------------------------------------------------
let auth = { cookie: '', token: '', fetchedAt: 0, inFlight: null };

function readTokenUrl() {
  const raw = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  return new URL(raw);
}

function exchangeToken(tokenUrl) {
  return new Promise((resolve, reject) => {
    const p = tokenUrl.pathname + (tokenUrl.search || '');
    const r = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: p,
        method: 'GET',
        headers: { host: UPSTREAM.host, accept: 'text/html' },
      },
      (res) => {
        res.resume();
        const set = res.headers['set-cookie'] || [];
        const m = /^(dsh-auth-[^=]+=[^;]+)/.exec(set[0] || '');
        if (!m) return reject(new Error('no dsh-auth cookie in response (status ' + res.statusCode + ')'));
        resolve(m[1]);
      }
    );
    r.on('error', reject);
    r.end();
  });
}

async function getCookie({ force = false } = {}) {
  if (!force && auth.cookie) return auth.cookie;
  if (auth.inFlight) return auth.inFlight;
  auth.inFlight = (async () => {
    const tokenUrl = readTokenUrl();
    const cookie = await exchangeToken(tokenUrl);
    auth = { cookie, token: tokenUrl.searchParams.get('token') || '', fetchedAt: Date.now(), inFlight: null };
    LOG('auth: cookie acquired', cookie.slice(0, 22) + '...');
    return cookie;
  })();
  try {
    return await auth.inFlight;
  } catch (e) {
    auth.inFlight = null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// HTTP proxy: /api/*
// ---------------------------------------------------------------------------
function proxyHttp(req, res, retried) {
  getCookie()
    .then((cookie) => {
      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      headers.cookie = cookie;
      headers.host = UPSTREAM.host;
      // Same-origin semantics: do not leak the client's origin to the host.
      delete headers.origin;
      const up = http.request(
        { host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: req.method, headers },
        (upRes) => {
          if (upRes.statusCode === 401 && !retried) {
            upRes.resume();
            LOG('api: 401 from upstream, refreshing auth cookie');
            getCookie({ force: true })
              .then(() => proxyHttp(req, res, true))
              .catch((e) => fail(res, 502, 'auth refresh failed: ' + e.message));
            return;
          }
          const outHeaders = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (k === 'transfer-encoding' || k === 'connection' || k === 'set-cookie') continue;
            outHeaders[k] = v;
          }
          outHeaders['cache-control'] = 'no-store';
          res.writeHead(upRes.statusCode || 502, outHeaders);
          upRes.pipe(res);
        }
      );
      up.on('error', (e) => fail(res, 502, 'upstream error: ' + e.message));
      req.pipe(up);
    })
    .catch((e) => fail(res, 502, 'auth failed: ' + e.message));
}

function fail(res, code, msg) {
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(msg + '\n');
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  } catch {
    return fail(res, 400, 'bad path');
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname === '/favicon.ico') {
    // Keep the browser console free of a harmless 404 in dev.
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    return fail(res, 403, 'forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'not found: ' + pathname);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// WebSocket proxy: /api/remote.mux (raw TCP pass-through around the upgrade)
// ---------------------------------------------------------------------------
function proxyUpgrade(req, socket, head, retried) {
  getCookie()
    .then((cookie) => {
      const headers = {
        ...req.headers,
        cookie,
        host: UPSTREAM.host,
      };
      delete headers.origin;
      const up = http.request({
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: req.url,
        method: 'GET',
        headers,
      });
      up.on('upgrade', (upRes, upSocket, upHead) => {
        let head101 = 'HTTP/1.1 101 ' + (upRes.statusMessage || 'Switching Protocols') + '\r\n';
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
          const k = upRes.rawHeaders[i];
          if (k.toLowerCase() === 'connection' || k.toLowerCase() === 'upgrade') continue;
          head101 += k + ': ' + upRes.rawHeaders[i + 1] + '\r\n';
        }
        head101 += 'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n';
        socket.write(head101);
        if (upHead && upHead.length) socket.write(upHead);
        if (head && head.length) upSocket.write(head);
        upSocket.pipe(socket);
        socket.pipe(upSocket);
        const close = () => { try { upSocket.destroy(); } catch {} try { socket.destroy(); } catch {} };
        upSocket.on('close', close);
        socket.on('close', close);
        upSocket.on('error', close);
        socket.on('error', close);
        LOG('ws: tunnel open', req.url);
      });
      up.on('response', (upRes) => {
        // Rejected handshake (401 etc.)
        upRes.resume();
        if (upRes.statusCode === 401 && !retried) {
          LOG('ws: 401 handshake, refreshing auth cookie and retrying');
          getCookie({ force: true })
            .then(() => proxyUpgrade(req, socket, head, true))
            .catch(() => failSocket(socket, 502));
          return;
        }
        LOG('ws: handshake rejected status=' + upRes.statusCode);
        failSocket(socket, upRes.statusCode || 502);
      });
      up.on('error', (e) => {
        LOG('ws: upstream error', e.message);
        failSocket(socket, 502);
      });
      up.end();
    })
    .catch((e) => {
      LOG('ws: auth failed', e.message);
      failSocket(socket, 502);
    });
}

function failSocket(socket, code) {
  try {
    socket.write('HTTP/1.1 ' + code + ' Error\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
  } catch {}
  socket.destroy();
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/api/')) {
    LOG(req.method, url);
    return proxyHttp(req, res, false);
  }
  return serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').startsWith('/api/')) {
    LOG('UPGRADE', req.url);
    return proxyUpgrade(req, socket, head, false);
  }
  failSocket(socket, 404);
});

// Tiny health endpoint for tooling (not part of the production wire protocol).
server.on('request', () => {});
server.listen(PORT, '127.0.0.1', () => {
  LOG('dev proxy listening on http://127.0.0.1:' + PORT + '/index.html');
  LOG('serving static root: ' + ROOT);
  LOG('upstream: ' + UPSTREAM.origin + ' (auth via ' + TOKEN_FILE + ')');
});

// Warm the cookie so the first browser request is fast.
getCookie().catch((e) => LOG('warning: initial auth failed:', e.message));
