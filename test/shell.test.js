'use strict';

/**
 * End-to-end test for the web terminal (/shell).
 * Run with: npm test   (or: node test/shell.test.js)
 */

const http = require('http');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { WebSocket } = require('ws');

const PASSWORD = 'test-password-123';
process.env.SHELL_PASSWORD = PASSWORD;
process.env.SHELL_TOKEN_FILE = path.join(os.tmpdir(), 'web-shell-test-token');
delete process.env.SHELL_DISABLE;
delete process.env.SHELL_CMD;
delete process.env.SHELL_PATH;

const shell = require('../shell');

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: options.port,
      method: options.method || 'GET',
      path: options.path,
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timeout waiting for ' + label));
      }
    }, 25);
  });
}

function openSocket(url, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: cookie ? { Cookie: cookie } : {} });
    const messages = [];
    ws.on('message', (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()));
      } catch (_) {
        /* ignore */
      }
    });
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

function outputOf(messages) {
  return messages.filter((m) => m.type === 'output').map((m) => m.data).join('');
}

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('app-404');
  });

  assert.strictEqual(shell.attach(server), true, 'attach() should enable the terminal');
  assert.strictEqual(shell.basePath, '/shell');

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const wsUrl = 'ws://127.0.0.1:' + port + '/shell/ws';
  const check = (name) => console.log('  ok  ' + name);

  try {
    // Existing app routes must keep working.
    let res = await request({ port, path: '/anything' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body, 'app-404');
    check('原有路由透传');

    // Bare prefix redirects to the trailing-slash URL (relative asset paths).
    res = await request({ port, path: '/shell' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/shell/');
    check('/shell 重定向到 /shell/');

    // Page and assets.
    res = await request({ port, path: '/shell/' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('xterm.js') && res.body.includes('login-form'));
    check('登录页可访问');

    res = await request({ port, path: '/shell/shell.js' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('MAX_AUTO_RETRIES'));
    check('前端脚本可访问');

    res = await request({ port, path: '/shell/xterm.js', headers: { 'Accept-Encoding': 'gzip' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-encoding'], 'gzip');
    check('xterm.js 本地资源（gzip）');

    res = await request({ port, path: '/shell/xterm.css' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('.xterm'));
    check('xterm.css 本地资源');

    // Auth gate.
    res = await request({ port, path: '/shell/api/session' });
    assert.strictEqual(JSON.parse(res.body).authenticated, false);
    check('未登录状态可查询');

    res = await request({
      port,
      path: '/shell/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, 'password=wrong');
    assert.strictEqual(res.status, 401);
    check('错误密码被拒绝');

    res = await request({
      port,
      path: '/shell/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, 'password=' + encodeURIComponent(PASSWORD));
    assert.strictEqual(res.status, 200);
    const setCookie = (res.headers['set-cookie'] || [])[0] || '';
    assert.ok(setCookie.startsWith('shell_session='), 'expected a session cookie');
    assert.ok(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie));
    const cookie = setCookie.split(';')[0];
    check('正确密码登录并下发 HttpOnly Cookie');

    res = await request({ port, path: '/shell/api/session', headers: { Cookie: cookie } });
    assert.strictEqual(JSON.parse(res.body).authenticated, true);
    check('Cookie 会话有效');

    // WebSocket requires the cookie.
    await new Promise((resolve, reject) => {
      const bad = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error('unauthorized upgrade did not fail')), 3000);
      bad.on('unexpected-response', (req, response) => {
        clearTimeout(timer);
        assert.strictEqual(response.statusCode, 401);
        resolve();
      });
      bad.on('open', () => {
        clearTimeout(timer);
        bad.close();
        reject(new Error('unauthenticated websocket was accepted'));
      });
      bad.on('error', () => { /* handled via unexpected-response */ });
    });
    check('未认证 WebSocket 被拒绝 (401)');

    // Interactive session.
    const { ws, messages } = await openSocket(wsUrl, cookie);
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    ws.send(JSON.stringify({
      type: 'input',
      data: 'stty size; echo "MARKER:$((6*7))"; echo READY_$((1+1))\r',
    }));

    await waitFor(() => outputOf(messages).includes('READY_2'), 8000, 'command output');
    const output = outputOf(messages);
    assert.ok(output.includes('40 120'), 'pty should honour the resize: ' + JSON.stringify(output));
    assert.ok(output.includes('MARKER:42'), 'shell command should run');
    assert.ok(/[@][^\r\n]*[#$]\s/.test(output), 'prompt should look like user@host:/path# ');
    check('PTY 交互、resize 与提示符');

    ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }));
    await waitFor(() => messages.some((m) => m.type === 'exit'), 5000, 'exit event');
    check('退出事件回传');

    // Logout invalidates the cookie.
    res = await request({
      port,
      path: '/shell/logout',
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.strictEqual(res.status, 200);
    res = await request({ port, path: '/shell/api/session', headers: { Cookie: cookie } });
    assert.strictEqual(JSON.parse(res.body).authenticated, false);
    check('退出登录使会话失效');

    console.log('\nAll web terminal checks passed.');
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 100);
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
