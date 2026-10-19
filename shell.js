'use strict';

/**
 * Web terminal for the container.
 *
 * Mounts an authenticated interactive shell on http://<host>:<PORT>/shell
 * (path configurable via SHELL_PATH) using xterm.js + node-pty over WebSocket.
 *
 * Environment:
 *   SHELL_DISABLE=1        turn the terminal off completely
 *   SHELL_PASSWORD=...     login password (generated + persisted when unset)
 *   SHELL_TOKEN_FILE=...   where the generated password is stored
 *   SHELL_PATH=/shell      URL prefix
 *   SHELL_CMD="htop"       command to run instead of the login shell
 *   SHELL_CWD=/root        initial working directory
 *   SHELL_MAX_SESSIONS=5   concurrent terminal limit
 *   SHELL_SESSION_TTL_MS   login cookie lifetime (default 12h)
 *
 * Security: this grants remote command execution as the process user.
 * Always keep SHELL_PASSWORD set to a strong secret on a public VPS.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const SHELL_VERSION = '1.0.0';

const BASE_PATH = normalizeBase(process.env.SHELL_PATH || '/shell');
const PUBLIC_DIR = path.join(__dirname, 'public', 'shell');
const COOKIE_NAME = 'shell_session';
const SESSION_TTL_MS = toInt(process.env.SHELL_SESSION_TTL_MS, 12 * 60 * 60 * 1000);
const MAX_SESSIONS = Math.max(1, toInt(process.env.SHELL_MAX_SESSIONS, 5));
const MAX_BODY = 2048;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;

const sessions = new Map(); // sid -> expiresAt
const loginFailures = new Map(); // ip -> { count, resetAt }
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let enabled = false;
let password = '';
let passwordWasGenerated = false;
let rcFile = '';
let activeSessions = 0;
let attached = false;

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeBase(raw) {
  let base = String(raw || '/shell').trim();
  if (!base.startsWith('/')) base = '/' + base;
  base = base.replace(/\/+$/, '');
  return base || '/shell';
}

function log(message) {
  try {
    process.stdout.write('[shell] ' + message + '\n');
  } catch (_) {
    /* stdout may be gone during shutdown */
  }
}

function isEnabled() {
  return !/^(1|true|yes|on)$/i.test(String(process.env.SHELL_DISABLE || '')) &&
    !/^(0|false|no|off)$/i.test(String(process.env.SHELL_ENABLED || ''));
}

/* ------------------------------------------------------------------ */
/* Password / session handling                                         */
/* ------------------------------------------------------------------ */

function tokenFilePath() {
  return process.env.SHELL_TOKEN_FILE || path.join(process.cwd(), '.shell-token');
}

function readTokenFile() {
  try {
    const value = fs.readFileSync(tokenFilePath(), 'utf8').trim();
    return value.length >= 8 ? value : '';
  } catch (_) {
    return '';
  }
}

function writeTokenFile(value) {
  try {
    fs.writeFileSync(tokenFilePath(), value + '\n', { mode: 0o600 });
    return true;
  } catch (err) {
    log('could not persist password to ' + tokenFilePath() + ': ' + err.message);
    return false;
  }
}

function initPassword() {
  const fromEnv = String(process.env.SHELL_PASSWORD || '').trim();
  if (fromEnv) return { value: fromEnv, generated: false };

  const stored = readTokenFile();
  if (stored) return { value: stored, generated: false };

  const generated = crypto.randomBytes(18).toString('base64url');
  writeTokenFile(generated);
  return { value: generated, generated: true };
}

function sameSecret(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch (_) {
      out[key] = value;
    }
  }
  return out;
}

function issueSession() {
  const sid = crypto.randomBytes(32).toString('base64url');
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  return sid;
}

function validSessionId(sid) {
  if (!sid) return false;
  const expiresAt = sessions.get(sid);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(sid);
    return false;
  }
  return true;
}

function isAuthenticated(req) {
  return validSessionId(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

function sessionCookie(sid, maxAgeSeconds) {
  return COOKIE_NAME + '=' + encodeURIComponent(sid) +
    '; Path=' + BASE_PATH + '; HttpOnly; SameSite=Strict; Max-Age=' + maxAgeSeconds;
}

function tooManyFailures(ip) {
  const record = loginFailures.get(ip);
  if (!record) return false;
  if (record.resetAt <= Date.now()) {
    loginFailures.delete(ip);
    return false;
  }
  return record.count >= LOGIN_MAX_FAILURES;
}

function recordFailure(ip) {
  const now = Date.now();
  const record = loginFailures.get(ip);
  if (!record || record.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  record.count += 1;
}

function clientIp(req) {
  const forwarded = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ------------------------------------------------------------------ */
/* PTY helpers                                                         */
/* ------------------------------------------------------------------ */

function bashRcFile() {
  const content = [
    '# generated by the web shell - do not edit, it is rewritten on start',
    'if [ -f /etc/bash.bashrc ]; then . /etc/bash.bashrc; fi',
    'if [ -f /etc/profile ]; then . /etc/profile; fi',
    'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    'export TERM="${TERM:-xterm-256color}"',
    'if [ "$(id -u)" -eq 0 ]; then',
    "  PS1='\\[\\e[1;31m\\]\\u\\[\\e[0m\\]@\\[\\e[1;36m\\]\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]# '",
    'else',
    "  PS1='\\[\\e[1;32m\\]\\u\\[\\e[0m\\]@\\[\\e[1;36m\\]\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ '",
    'fi',
    'unset HISTFILE',
    '',
  ].join('\n');
  const file = path.join(os.tmpdir(), 'web-shell-bashrc-' + process.pid);
  try {
    fs.writeFileSync(file, content, { mode: 0o600 });
    return file;
  } catch (err) {
    log('could not write bashrc: ' + err.message);
    return '';
  }
}

function resolveShell() {
  const custom = String(process.env.SHELL_CMD || '').trim();
  if (custom) return { file: '/bin/sh', args: ['-c', 'exec ' + custom] };

  const candidates = ['/bin/bash', process.env.SHELL, '/bin/sh'];
  const shellPath = candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '/bin/sh';

  if (/bash$/.test(shellPath) && rcFile) {
    return { file: shellPath, args: ['--rcfile', rcFile, '-i'] };
  }
  return { file: shellPath, args: ['-i'] };
}

function shellEnvironment() {
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLICOLOR: '1',
    SHELL_SESSION: 'web',
  });
  if (!env.LANG || /^C(\.|$)/.test(env.LANG)) {
    if (fs.existsSync('/usr/share/locale/en_US.UTF-8')) env.LANG = 'en_US.UTF-8';
  }
  delete env.SHELL_PASSWORD;
  return env;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------------ */
/* HTTP layer                                                          */
/* ------------------------------------------------------------------ */

const gzipCache = new Map();

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendText(res, status, text, extraHeaders) {
  const body = Buffer.from(text);
  res.writeHead(status, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveFile(req, res, filePath, cacheSeconds) {
  fs.readFile(filePath, (err, body) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = mimeTypes[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Cache-Control': cacheSeconds > 0 ? 'public, max-age=' + cacheSeconds : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };

    const wantsGzip = /gzip/.test(String(req.headers['accept-encoding'] || '')) &&
      /^(text|application\/(javascript|json)|image\/svg)/.test(type);

    if (wantsGzip) {
      let compressed = gzipCache.get(filePath);
      if (compressed === undefined) {
        try {
          compressed = zlib.gzipSync(body, { level: 6 });
          if (compressed.length < 64 * 1024) gzipCache.set(filePath, compressed);
        } catch (_) {
          compressed = null;
        }
      }
      if (compressed) {
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = compressed.length;
        headers.Vary = 'Accept-Encoding';
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : compressed);
        return;
      }
    }

    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

function handleLogin(req, res) {
  const ip = clientIp(req);
  if (tooManyFailures(ip)) {
    sendJson(res, 429, { ok: false, error: '尝试次数过多，请 5 分钟后再试' });
    return;
  }

  readBody(req, MAX_BODY).then((raw) => {
    let supplied = '';
    const contentType = String(req.headers['content-type'] || '');
    if (contentType.includes('application/json')) {
      try {
        supplied = String((JSON.parse(raw) || {}).password || '');
      } catch (_) {
        supplied = '';
      }
    } else {
      supplied = String(new URLSearchParams(raw).get('password') || '');
    }

    if (!supplied || !sameSecret(supplied, password)) {
      recordFailure(ip);
      log('failed login from ' + ip);
      sendJson(res, 401, { ok: false, error: '密码错误' });
      return;
    }

    loginFailures.delete(ip);
    const sid = issueSession();
    res.setHeader('Set-Cookie', sessionCookie(sid, Math.floor(SESSION_TTL_MS / 1000)));
    log('login from ' + ip);
    sendJson(res, 200, { ok: true });
  }).catch(() => {
    sendJson(res, 413, { ok: false, error: '请求过大' });
  });
}

function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    return false;
  }
  const pathname = url.pathname;
  if (pathname !== BASE_PATH && !pathname.startsWith(BASE_PATH + '/')) return false;

  const method = req.method || 'GET';
  const relative = pathname === BASE_PATH ? '' : pathname.slice(BASE_PATH.length);

  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');

  // Relative asset URLs need the trailing slash.
  if (relative === '' && method === 'GET') {
    res.writeHead(302, {
      Location: BASE_PATH + '/' + url.search,
      'Cache-Control': 'no-store',
    });
    res.end();
    return true;
  }

  if (method === 'POST' && relative === '/login') {
    handleLogin(req, res);
    return true;
  }

  if (method === 'POST' && relative === '/logout') {
    const sid = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return true;
  }

  if (relative === '/api/session') {
    sendJson(res, 200, {
      authenticated: isAuthenticated(req),
      version: SHELL_VERSION,
      maxSessions: MAX_SESSIONS,
    });
    return true;
  }

  if (relative === '/xterm.js' || relative === '/xterm.css' || relative === '/xterm-addon-fit.js') {
    serveFile(req, res, path.join(PUBLIC_DIR, 'vendor', relative.slice(1)), 86400);
    return true;
  }

  if (relative === '/shell.js') {
    serveFile(req, res, path.join(PUBLIC_DIR, 'shell.js'), 0);
    return true;
  }

  // A token in the query string logs the browser in once, then it is stripped.
  const token = url.searchParams.get('token') || url.searchParams.get('password');
  if (token && relative === '/') {
    if (sameSecret(token, password)) {
      const sid = issueSession();
      res.writeHead(302, {
        'Set-Cookie': sessionCookie(sid, Math.floor(SESSION_TTL_MS / 1000)),
        Location: BASE_PATH + '/',
        'Cache-Control': 'no-store',
      });
      res.end();
    } else {
      sendText(res, 401, 'Invalid token');
    }
    return true;
  }

  if (relative === '/' || relative === '/index.html') {
    serveFile(req, res, path.join(PUBLIC_DIR, 'shell.html'), 0);
    return true;
  }

  sendText(res, 404, 'Not found');
  return true;
}

/* ------------------------------------------------------------------ */
/* WebSocket PTY bridge                                               */
/* ------------------------------------------------------------------ */

function attach(server) {
  if (attached) return true;
  attached = true;

  if (!isEnabled()) {
    log('disabled (SHELL_DISABLE is set)');
    return false;
  }

  enabled = true;
  const resolved = initPassword();
  password = resolved.value;
  passwordWasGenerated = resolved.generated;
  rcFile = bashRcFile();

  const pty = require('node-pty');
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false });

  // Take over the HTTP request lifecycle only for our namespace, so the
  // existing app routes keep working untouched.
  const previousListeners = server.listeners('request').slice();
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let handled = false;
    try {
      handled = handleRequest(req, res);
    } catch (err) {
      log('request error: ' + (err && err.stack ? err.stack : err));
      if (!res.headersSent) sendText(res, 500, 'Internal error');
      else res.end();
      return;
    }
    if (handled) return;
    for (const listener of previousListeners) listener.call(server, req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      return;
    }
    if (pathname !== BASE_PATH + '/ws') return;

    if (!isAuthenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    if (activeSessions >= MAX_SESSIONS) {
      try {
        ws.send(JSON.stringify({
          type: 'fatal',
          message: '已达到最大会话数（' + MAX_SESSIONS + '），请关闭其他终端后重试。',
        }));
      } catch (_) { /* ignore */ }
      ws.close(1013, 'too many sessions');
      return;
    }

    activeSessions += 1;
    log('session opened from ' + ip + ' (' + activeSessions + '/' + MAX_SESSIONS + ')');

    const shell = resolveShell();
    let term;
    try {
      term = pty.spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.env.SHELL_CWD || process.env.HOME || process.cwd(),
        env: shellEnvironment(),
      });
    } catch (err) {
      activeSessions -= 1;
      try {
        ws.send(JSON.stringify({ type: 'fatal', message: '无法启动 shell: ' + err.message }));
      } catch (_) { /* ignore */ }
      ws.close(1011, 'spawn failed');
      return;
    }

    let closed = false;
    let paused = false;

    const send = (payload) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(payload));
    };

    // Simple backpressure: stop reading the pty while the socket is clogged.
    const flowTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (!paused && ws.bufferedAmount > 2 * 1024 * 1024) {
        paused = true;
        try { term.pause(); } catch (_) { /* ignore */ }
      } else if (paused && ws.bufferedAmount < 256 * 1024) {
        paused = false;
        try { term.resume(); } catch (_) { /* ignore */ }
      }
    }, 100);
    if (flowTimer.unref) flowTimer.unref();

    term.onData((data) => send({ type: 'output', data }));
    term.onExit((event) => {
      send({ type: 'exit', code: event && event.exitCode, signal: event && event.signal });
      try { ws.close(1000, 'shell exited'); } catch (_) { /* ignore */ }
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'input' && typeof msg.data === 'string') {
        try { term.write(msg.data); } catch (_) { /* ignore */ }
      } else if (msg.type === 'resize') {
        const cols = clampInt(msg.cols, 2, 1000, 80);
        const rows = clampInt(msg.rows, 2, 500, 24);
        try { term.resize(cols, rows); } catch (_) { /* ignore */ }
      } else if (msg.type === 'ping') {
        send({ type: 'pong', t: Date.now() });
      }
    });

    const shutdown = () => {
      if (closed) return;
      closed = true;
      clearInterval(flowTimer);
      activeSessions = Math.max(0, activeSessions - 1);
      log('session closed from ' + ip + ' (' + activeSessions + '/' + MAX_SESSIONS + ')');
      try { term.kill(); } catch (_) { /* already gone */ }
    };

    ws.on('close', shutdown);
    ws.on('error', shutdown);
  });

  const printBanner = () => {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : (process.env.PORT || 3000);
    const host = process.env.ARGO_DOMAIN && !/^(true|false)$/i.test(process.env.ARGO_DOMAIN)
      ? process.env.ARGO_DOMAIN
      : 'localhost';
    log([
      '============================================================',
      ' Web terminal ready:  http://' + host + ':' + port + BASE_PATH + '/',
      ' Password:            ' + password,
      passwordWasGenerated
        ? ' (generated, saved to ' + tokenFilePath() + '; set SHELL_PASSWORD to pin it)'
        : ' (from SHELL_PASSWORD)',
      '============================================================',
    ].join('\n'));
  };

  if (server.listening) printBanner();
  else server.once('listening', printBanner);

  process.once('exit', () => {
    if (!rcFile) return;
    try { fs.unlinkSync(rcFile); } catch (_) { /* ignore */ }
  });

  return true;
}

module.exports = {
  attach,
  get enabled() { return enabled; },
  get basePath() { return BASE_PATH; },
};
