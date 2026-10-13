'use strict';
// Opens a session in a DETACHED tmux session, then attaches an iTerm tab to it.
// Detached-first means closing the terminal never kills the work.

const fs = require('fs');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { HOME } = require('./paths');
const openset = require('./openset');

const SESSION_ID_RE = /^[A-Za-z0-9._-]{4,80}$/;

function tmuxName(sessionId) { return 'wb_' + sessionId.slice(0, 8); }

function shq(s) { return "'" + String(s).replace(/'/g, `'\\''`) + "'"; }

function tmuxBin() {
  for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
    if (fs.existsSync(p)) return p;
  }
  return 'tmux';
}

function hasSession(name) {
  try {
    execFileSync(tmuxBin(), ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function launch({ sessionId, cwd, attach = true, fork = false }) {
  if (!SESSION_ID_RE.test(String(sessionId || ''))) throw new Error('invalid session id');
  let dir = cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : HOME;

  const name = tmuxName(sessionId);
  const tmux = tmuxBin();
  const created = !hasSession(name);

  if (created) {
    execFileSync(tmux, ['new-session', '-d', '-s', name, '-c', dir]);
    // The dock and the iTerm tab title already say which session this is, and the
    // window follows whichever client is active so browser and iTerm can swap freely.
    for (const opt of [['status', 'off'], ['history-limit', '50000'], ['window-size', 'latest'], ['focus-events', 'on']]) {
      try { execFileSync(tmux, ['set-option', '-t', name, ...opt], { stdio: 'ignore' }); } catch {}
    }
    // Run inside a live shell (not as the session command) so the tmux session
    // outlives claude exiting and stays reusable.
    const cmd = ['claude', '--resume', shq(sessionId)];
    if (fork) cmd.push('--fork-session');
    execFileSync(tmux, ['send-keys', '-t', name, cmd.join(' '), 'Enter']);
  }
  // A fork continues under a NEW session id we never learn, so it can't be
  // brought back after a reboot — don't remember it.
  if (!fork) openset.add(sessionId, created || dir === cwd ? dir : null, created);

  const attachCmd = `${tmux} attach -t ${shq(name)}`;
  if (attach) {
    const osa = `
      tell application "iTerm"
        activate
        if (count of windows) = 0 then
          create window with default profile
          tell current session of current window to write text ${JSON.stringify(attachCmd)}
        else
          tell current window
            create tab with default profile
            tell current session to write text ${JSON.stringify(attachCmd)}
          end tell
        end if
      end tell`;
    execFile('/usr/bin/osascript', ['-e', osa], () => {});
  }

  return { tmuxSession: name, created, attachCmd, cwd: dir };
}

// A tmux session outliving `claude` is normal — the pane drops back to a shell.
// Only report sessions where something is actually running, or the board shows a
// live dot for work that has already finished.
const SHELLS = new Set(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish', 'login']);

function listLive() {
  try {
    const out = execFileSync(tmuxBin(),
      ['list-panes', '-a', '-F', '#{session_name} #{pane_current_command}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const live = new Set();
    for (const line of out.split('\n')) {
      const [name, cmd] = line.trim().split(/\s+/);
      if (!name || !name.startsWith('wb_')) continue;
      if (SHELLS.has((cmd || '').trim())) continue;
      live.add(name);
    }
    return [...live];
  } catch { return []; }
}

// tmux sessions whose pane has fallen back to a shell: the work ended but the
// container is still around.
function listIdle() {
  try {
    const out = execFileSync(tmuxBin(),
      ['list-panes', '-a', '-F', '#{session_name} #{pane_current_command}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const live = new Set(listLive());
    const idle = new Set();
    for (const line of out.split('\n')) {
      const [name] = line.trim().split(/\s+/);
      if (!name || !name.startsWith('wb_') || live.has(name)) continue;
      idle.add(name);
    }
    return [...idle];
  } catch { return []; }
}

// Starts a NEW conversation rather than resuming one. The session id is minted
// here and handed to `claude --session-id`, so the tmux session, the browser tab
// and the transcript that appears later all share one identity.
function create({ cwd, title }) {
  const dir = cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory() ? cwd : HOME;
  const sessionId = crypto.randomUUID();
  const name = tmuxName(sessionId);
  const tmux = tmuxBin();

  execFileSync(tmux, ['new-session', '-d', '-s', name, '-c', dir]);
  for (const opt of [['status', 'off'], ['history-limit', '50000'], ['window-size', 'latest'], ['focus-events', 'on']]) {
    try { execFileSync(tmux, ['set-option', '-t', name, ...opt], { stdio: 'ignore' }); } catch {}
  }

  const cmd = ['claude', '--session-id', shq(sessionId)];
  if (title && String(title).trim()) cmd.push('--name', shq(String(title).trim().slice(0, 80)));
  execFileSync(tmux, ['send-keys', '-t', name, cmd.join(' '), 'Enter']);
  openset.add(sessionId, dir, true);

  return {
    sessionId,
    tmuxSession: name,
    cwd: dir,
    title: (title && String(title).trim()) || ('New session · ' + require('path').basename(dir)),
    created: true,
    attachCmd: `${tmux} attach -t ${shq(name)}`,
  };
}

// Reads a pane's text straight out of tmux. The TUI holds the mouse, so this is
// the dependable way to get output out — and it reaches real scrollback, which a
// browser selection cannot.
function capture(sessionId, lines) {
  if (!SESSION_ID_RE.test(String(sessionId || ''))) throw new Error('invalid session id');
  const name = tmuxName(sessionId);
  if (!hasSession(name)) throw new Error('no live session');
  const n = Math.max(0, Math.min(50000, Math.floor(Number(lines) || 0)));
  const args = ['capture-pane', '-p', '-J', '-t', name];
  if (n > 0) args.splice(3, 0, '-S', String(-n));
  const out = execFileSync(tmuxBin(), args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.replace(/\s+$/, '');
}

// Is a turn actually in flight? The TUI prints "esc to interrupt" in its footer
// for exactly as long as it is working, so the pane text is the only place that
// knows — the process tree looks identical busy or idle.
const BUSY_RE = /esc to interrupt/;

function status(sessionId) {
  if (!SESSION_ID_RE.test(String(sessionId || ''))) throw new Error('invalid session id');
  const name = tmuxName(sessionId);
  if (!hasSession(name)) return { alive: false, running: false, busy: false, tmuxSession: name };
  let cmd = '';
  try {
    cmd = execFileSync(tmuxBin(), ['display', '-p', '-t', name, '#{pane_current_command}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {}
  const running = !SHELLS.has(cmd);
  let busy = false;
  if (running) {
    // Only the visible screen: the footer is redrawn in place, so a stale
    // "esc to interrupt" in scrollback would read as busy forever.
    try {
      const pane = execFileSync(tmuxBin(), ['capture-pane', '-p', '-J', '-t', name],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      busy = BUSY_RE.test(pane);
    } catch {}
  }
  return { alive: true, running, busy, tmuxSession: name };
}

// Ends the work, as opposed to detaching a viewport from it.
function end(sessionId) {
  if (!SESSION_ID_RE.test(String(sessionId || ''))) throw new Error('invalid session id');
  const name = tmuxName(sessionId);
  openset.remove(sessionId);
  if (!hasSession(name)) return { killed: false, tmuxSession: name };
  execFileSync(tmuxBin(), ['kill-session', '-t', name], { stdio: 'ignore' });
  return { killed: true, tmuxSession: name };
}

// Removes tmux containers whose work has already finished.
function pruneIdle() {
  const killed = [];
  for (const name of listIdle()) {
    try { execFileSync(tmuxBin(), ['kill-session', '-t', name], { stdio: 'ignore' }); killed.push(name); } catch {}
  }
  // Cleared on purpose — without this a container whose claude never started
  // would read as "lost in a reboot" and be relaunched.
  openset.remove(openset.ids().filter((id) => killed.includes(tmuxName(id))));
  return killed;
}

// Sessions that were open when tmux last went away (a reboot) and should come
// back. Also retires records whose claude has exited.
function restorable() {
  return openset.reconcile(listLive(), listIdle(), tmuxName);
}

module.exports = { launch, create, end, status, capture, listLive, listIdle, pruneIdle, restorable, tmuxName };
