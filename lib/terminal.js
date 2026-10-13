'use strict';
// Bridges a browser terminal to a tmux session over a WebSocket.
//
// tmux stays the durable layer: the browser is just another client. Closing the
// tab detaches; the session keeps running and iTerm can attach to the same one.

const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { HOME } = require('./paths');
const launcher = require('./launch');

const PTYHOST = path.join(__dirname, 'ptyhost.py');
const SESSION_RE = /^[A-Za-z0-9._-]{4,80}$/;
const MAX_COLS = 500, MAX_ROWS = 200;

function tmuxBin() {
  for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
    if (fs.existsSync(p)) return p;
  }
  return 'tmux';
}

function clamp(n, lo, hi, dflt) {
  n = Math.floor(Number(n));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
}

// Ensure the tmux session exists without opening an iTerm tab.
function ensureSession({ sessionId, cwd, fork }) {
  return launcher.launch({ sessionId, cwd, fork, attach: false });
}

function attach(ws, opts) {
  const sessionId = String(opts.sessionId || '');
  if (!SESSION_RE.test(sessionId)) { ws.close(1008, 'bad session id'); return; }

  const cols = clamp(opts.cols, 20, MAX_COLS, 120);
  const rows = clamp(opts.rows, 5, MAX_ROWS, 32);

  let info;
  try {
    info = ensureSession({ sessionId, cwd: opts.cwd, fork: !!opts.fork });
  } catch (err) {
    ws.send(JSON.stringify({ t: 'err', m: String(err.message || err) }));
    ws.close(1011, 'launch failed');
    return;
  }

  const tmux = tmuxBin();
  // "latest" makes the window follow whichever client is active, so attaching from
  // iTerm later does not leave the browser's geometry pinned on it.
  try {
    execFileSync(tmux, ['set-option', '-t', info.tmuxSession, 'window-size', 'latest'], { stdio: 'ignore' });
    execFileSync(tmux, ['set-option', '-t', info.tmuxSession, 'status', 'off'], { stdio: 'ignore' });
  } catch {}

  const pty = spawn('python3', [PTYHOST, String(cols), String(rows), tmux, '-u', 'attach', '-t', info.tmuxSession], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { TERM: 'xterm-256color', HOME }),
  });

  let closed = false;
  const shutdown = (why) => {
    if (closed) return;
    closed = true;
    try { pty.stdin.end(); } catch {}
    try { pty.kill('SIGHUP'); } catch {}
    setTimeout(() => { try { pty.kill('SIGKILL'); } catch {} }, 1200).unref();
    try { if (ws.readyState === ws.OPEN) ws.close(1000, why || 'closed'); } catch {}
  };

  ws.send(JSON.stringify({ t: 'ready', tmux: info.tmuxSession, created: info.created, cwd: info.cwd }));

  pty.stdout.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
  pty.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.trim() && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'err', m: s.slice(0, 400) }));
  });
  pty.on('exit', () => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'exit' }));
    shutdown('pty exit');
  });
  pty.on('error', (e) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'err', m: String(e.message) }));
    shutdown('pty error');
  });

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    if (isBinary) { try { pty.stdin.write(data); } catch {} return; }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      try { pty.stdin.write(msg.d); } catch {}
    } else if (msg.t === 'r') {
      const c = clamp(msg.c, 20, MAX_COLS, cols), r = clamp(msg.r, 5, MAX_ROWS, rows);
      // The pty winsize + SIGWINCH is enough: tmux resizes the client, and
      // window-size=latest resizes the window to match.
      try { pty.stdio[3].write(`R ${c} ${r}\n`); } catch {}
    }
  });

  ws.on('close', () => shutdown('ws close'));
  ws.on('error', () => shutdown('ws error'));
}

module.exports = { attach };
