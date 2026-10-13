'use strict';
// Which sessions the workbench has open. tmux is the live truth, but it dies
// with the machine — this record is what survives a reboot, so the page can
// bring the same sessions back. Only a real close removes an entry: ✕ end,
// wrap-up "end", clearing finished containers, or claude seen exiting while its
// tmux stayed up. A reboot does none of those.

const fs = require('fs');
const path = require('path');
const { WB_DIR } = require('./paths');

const FILE = path.join(WB_DIR, 'data', 'open.json');

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && j.sessions && typeof j.sessions === 'object') return j;
  } catch {}
  return { version: 1, sessions: {} };
}

function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

// `fresh` = a new tmux was just made for it. Its pane is a bare shell until
// claude starts, so it must not count as "exited" until it has been seen running.
function add(sessionId, cwd, fresh) {
  const db = load();
  const cur = db.sessions[sessionId];
  if (cur && !fresh && (cur.cwd || null) === (cwd || null)) return;
  db.sessions[sessionId] = {
    cwd: cwd || (cur && cur.cwd) || null,
    openedAt: (cur && cur.openedAt) || new Date().toISOString(),
    seenRunning: fresh ? false : !!(cur && cur.seenRunning),
  };
  save(db);
}

function remove(ids) {
  const db = load();
  let n = 0;
  for (const id of [].concat(ids)) if (db.sessions[id]) { delete db.sessions[id]; n++; }
  if (n) save(db);
}

function ids() { return Object.keys(load().sessions); }

// Bring the record in line with tmux. `name` maps a session id to its tmux name.
// Returns the sessions to restore: remembered, but with no tmux at all.
function reconcile(live, idle, name) {
  const db = load();
  const liveSet = new Set(live), idleSet = new Set(idle);
  const restore = [];
  let dirty = false;
  for (const [id, s] of Object.entries(db.sessions)) {
    const n = name(id);
    if (liveSet.has(n)) {
      if (!s.seenRunning) { s.seenRunning = true; dirty = true; }
    } else if (idleSet.has(n)) {
      // claude was running here and is not any more: the person exited it.
      if (s.seenRunning) { delete db.sessions[id]; dirty = true; }
    } else {
      restore.push({ sessionId: id, cwd: s.cwd });
    }
  }
  if (dirty) save(db);
  return restore;
}

module.exports = { add, remove, ids, reconcile, FILE };
