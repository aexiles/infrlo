(function () {
  'use strict';

  var BASE = location.pathname.replace(/\/+$/, '') || '/shell';
  var MAX_AUTO_RETRIES = 3;

  var terminalHost = document.getElementById('terminal');
  var dot = document.getElementById('dot');
  var statusText = document.getElementById('status-text');
  var loginOverlay = document.getElementById('login-overlay');
  var offlineOverlay = document.getElementById('offline-overlay');
  var offlineTitle = document.getElementById('offline-title');
  var offlineMessage = document.getElementById('offline-message');
  var loginForm = document.getElementById('login-form');
  var passwordInput = document.getElementById('password');
  var loginError = document.getElementById('login-error');
  var loginButton = document.getElementById('btn-login');

  var ws = null;
  var retries = 0;
  var retryTimer = null;
  var closingIntentionally = false;
  var sessionEnded = false;
  var fitTimer = null;

  var term = new window.Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: 'Menlo, Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
    fontSize: window.innerWidth < 640 ? 12 : 14,
    lineHeight: 1.15,
    letterSpacing: 0,
    scrollback: 8000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: {
      background: '#0b0f14',
      foreground: '#d8e1ea',
      cursor: '#38bdf8',
      cursorAccent: '#0b0f14',
      selectionBackground: 'rgba(56, 189, 248, 0.30)',
      black: '#1b2733',
      red: '#f87171',
      green: '#34d399',
      yellow: '#fbbf24',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#d8e1ea',
      brightBlack: '#64748b',
      brightRed: '#fca5a5',
      brightGreen: '#6ee7b7',
      brightYellow: '#fcd34d',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#f8fafc'
    }
  });
  var fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(terminalHost);

  function setStatus(text, cls) {
    statusText.textContent = text;
    dot.className = 'dot' + (cls ? ' ' + cls : '');
  }

  function showOverlay(el) {
    el.hidden = false;
  }

  function hideOverlay(el) {
    el.hidden = true;
  }

  function showLogin() {
    showOverlay(loginOverlay);
    hideOverlay(offlineOverlay);
    setStatus('未登录', 'off');
    setTimeout(function () { passwordInput.focus(); }, 30);
  }

  function showOffline(title, message) {
    offlineTitle.textContent = title;
    offlineMessage.textContent = message;
    showOverlay(offlineOverlay);
    hideOverlay(loginOverlay);
    setStatus('已断开', 'off');
  }

  function hideOverlays() {
    hideOverlay(loginOverlay);
    hideOverlay(offlineOverlay);
  }

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function applyFit() {
    try {
      fitAddon.fit();
      if (term.cols && term.rows) send({ type: 'resize', cols: term.cols, rows: term.rows });
    } catch (_) { /* layout not ready */ }
  }

  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(applyFit, 80);
  }

  term.onData(function (data) {
    send({ type: 'input', data: data });
  });

  term.onResize(function (size) {
    send({ type: 'resize', cols: size.cols, rows: size.rows });
  });

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    clearTimeout(retryTimer);
    closingIntentionally = false;
    sessionEnded = false;
    setStatus(retries ? '重连中…' : '连接中…', 'busy');

    var scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(scheme + '//' + location.host + BASE + '/ws');

    ws.onopen = function () {
      retries = 0;
      hideOverlays();
      setStatus('已连接', 'on');
      applyFit();
      term.focus();
    };

    ws.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'output' && typeof msg.data === 'string') {
        term.write(msg.data);
      } else if (msg.type === 'fatal') {
        sessionEnded = true;
        showOffline('无法打开终端', msg.message || '会话被拒绝');
      } else if (msg.type === 'exit') {
        sessionEnded = true;
        var detail = typeof msg.code === 'number' ? '（退出码 ' + msg.code + '）' : '';
        showOffline('会话已结束', 'shell 进程已退出' + detail + '，点击下方按钮可重新打开。');
      }
    };

    ws.onclose = function () {
      ws = null;
      setStatus('已断开', 'off');
      if (closingIntentionally || sessionEnded) return;

      if (retries < MAX_AUTO_RETRIES) {
        retries += 1;
        setStatus('重连中… (' + retries + '/' + MAX_AUTO_RETRIES + ')', 'busy');
        retryTimer = setTimeout(function () {
          // The cookie may have expired while the tab was idle.
          fetch(BASE + '/api/session', { cache: 'no-store', credentials: 'same-origin' })
            .then(function (res) { return res.json(); })
            .then(function (data) {
              if (data && data.authenticated) connect();
              else showLogin();
            })
            .catch(function () { connect(); });
        }, 800 * retries);
      } else {
        showOffline('连接已断开', '无法连接服务器，请检查网络后重试。');
      }
    };

    ws.onerror = function () {
      // onclose performs the retry/cleanup work.
    };
  }

  function disconnect(code, reason) {
    closingIntentionally = true;
    clearTimeout(retryTimer);
    if (ws) {
      try { ws.close(code || 1000, reason || 'client'); } catch (_) { /* ignore */ }
      ws = null;
    }
  }

  function login(event) {
    event.preventDefault();
    var value = passwordInput.value;
    if (!value) {
      loginError.textContent = '请输入密码';
      return;
    }
    loginButton.disabled = true;
    loginError.textContent = '';
    fetch(BASE + '/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent(value)
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (result) {
      loginButton.disabled = false;
      if (!result.ok || !result.data || !result.data.ok) {
        loginError.textContent = (result.data && result.data.error) || '登录失败';
        passwordInput.select();
        return;
      }
      passwordInput.value = '';
      hideOverlays();
      connect();
    }).catch(function () {
      loginButton.disabled = false;
      loginError.textContent = '网络错误，请重试';
    });
  }

  loginForm.addEventListener('submit', login);

  document.getElementById('btn-clear').addEventListener('click', function () {
    term.clear();
    term.write('\x1b[H\x1b[2J');
    term.focus();
  });

  document.getElementById('btn-full').addEventListener('click', function () {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () { /* ignore */ });
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () { /* ignore */ });
    }
  });

  document.getElementById('btn-reconnect').addEventListener('click', function () {
    disconnect(1000, 'manual reconnect');
    retries = 0;
    hideOverlays();
    connect();
  });

  document.getElementById('btn-retry').addEventListener('click', function () {
    retries = 0;
    hideOverlays();
    connect();
  });

  document.getElementById('btn-logout').addEventListener('click', function () {
    disconnect(1000, 'logout');
    fetch(BASE + '/logout', { method: 'POST', credentials: 'same-origin' })
      .catch(function () { /* ignore */ })
      .then(function () { location.reload(); });
  });

  document.getElementById('stage').addEventListener('click', function (event) {
    if (!loginOverlay.hidden || !offlineOverlay.hidden) return;
    if (event.target.closest('button')) return;
    term.focus();
  });

  document.addEventListener('fullscreenchange', scheduleFit);
  window.addEventListener('resize', scheduleFit);
  window.addEventListener('orientationchange', scheduleFit);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleFit);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) scheduleFit();
  });

  if (window.ResizeObserver) {
    new ResizeObserver(scheduleFit).observe(document.getElementById('stage'));
  }

  // Keep NAT / tunnel mappings alive while the tab sits idle.
  setInterval(function () {
    if (document.hidden) return;
    if (ws && ws.readyState === WebSocket.OPEN) send({ type: 'ping' });
  }, 25000);

  window.addEventListener('beforeunload', function () {
    closingIntentionally = true;
    if (ws) {
      try { ws.close(1000, 'unload'); } catch (_) { /* ignore */ }
    }
  });

  function checkSession() {
    fetch(BASE + '/api/session', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.authenticated) {
          connect();
        } else {
          showLogin();
          applyFit();
        }
      })
      .catch(function () {
        showLogin();
      });
  }

  applyFit();
  checkSession();
})();
