'use strict';
// The OVERLAY: the only data the workbench actually owns.
// Everything else is derived from transcripts and can be rebuilt at any time.
// An item is a unit of WORK and may own several sessions (merge).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ITEMS_FILE, BACKUP_DIR, DEV_ROOT, HOME } = require('./paths');

const STATUSES = ['inbox', 'active', 'paused', 'blocked', 'done', 'dropped'];
const BUCKETS = ['now', 'next', 'someday'];

function empty() { return { version: 1, items: {} }; }

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.items) return empty();
    return raw;
  } catch {
    return empty();
  }
}

// Overlay data is irreplaceable, so every write snapshots the previous file first.
function save(db) {
  fs.mkdirSync(path.dirname(ITEMS_FILE), { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(ITEMS_FILE)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(ITEMS_FILE, path.join(BACKUP_DIR, `items-${stamp}.json`)); } catch {}
    try {
      const olds = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('items-')).sort();
      for (const f of olds.slice(0, Math.max(0, olds.length - 50))) fs.unlinkSync(path.join(BACKUP_DIR, f));
    } catch {}
  }
  const tmp = ITEMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, ITEMS_FILE);
}

function newId() { return crypto.randomBytes(6).toString('hex'); }

function sessionOwners(db) {
  const map = Object.create(null);
  for (const it of Object.values(db.items)) {
    for (const sid of it.sessionIds || []) map[sid] = it.id;
  }
  return map;
}

// Human-readable project label. cwd wins when it points inside ~/dev,
// otherwise fall back to the repo inferred from transcript contents.
function projectLabel(sess) {
  const cwd = sess.cwd || '';
  if (cwd.startsWith(DEV_ROOT + '/')) {
    const rel = cwd.slice(DEV_ROOT.length + 1).split('/').filter(Boolean);
    return rel.slice(0, 2).join('/');
  }
  if (sess.repo) return sess.repo;
  if (cwd && cwd !== HOME) return path.basename(cwd);
  return null;
}

function titleFor(sess) {
  // A name the person typed (`--name`, /rename) beats the generated one.
  if (sess.customTitle) return sess.customTitle;
  if (sess.aiTitle) return sess.aiTitle;
  const p = (sess.firstPrompt || '').replace(/\s+/g, ' ').trim();
  if (p) return p.slice(0, 80) + (p.length > 80 ? '…' : '');
  return '(untitled session ' + String(sess.sessionId).slice(0, 8) + ')';
}

function baseItem(overrides) {
  const now = new Date().toISOString();
  return Object.assign({
    id: newId(),
    title: null,        // null => inherit from newest session
    status: 'inbox',
    bucket: 'next',
    assignee: null,
    tags: [],
    note: '',
    jiraKey: null,
    initiativeId: null,   // null => fall back to the rules classifier
    // Status is only ever set by a person. These record that a session ENDED
    // without one, so it can be asked about later — never to guess the status.
    needsWrapUp: false,
    endedAt: null,
    endReason: null,
    wrappedAt: null,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  }, overrides || {});
}

// Ensure a persisted item exists for a session; returns the item.
function ensureItem(db, sessionId, overrides) {
  const owners = sessionOwners(db);
  const existing = owners[sessionId];
  if (existing) return db.items[existing];
  const it = baseItem(Object.assign({ sessionIds: [sessionId] }, overrides));
  db.items[it.id] = it;
  return it;
}

function mergeItems(db, targetId, sourceIds) {
  const target = db.items[targetId];
  if (!target) throw new Error('unknown target item ' + targetId);
  for (const sid of sourceIds) {
    if (sid === targetId) continue;
    const src = db.items[sid];
    if (!src) continue;
    for (const s of src.sessionIds || []) {
      if (!target.sessionIds.includes(s)) target.sessionIds.push(s);
    }
    if (!target.note && src.note) target.note = src.note;
    for (const t of src.tags || []) if (!target.tags.includes(t)) target.tags.push(t);
    if (!target.jiraKey && src.jiraKey) target.jiraKey = src.jiraKey;
    if (!target.assignee && src.assignee) target.assignee = src.assignee;
    if (!target.initiativeId && src.initiativeId) target.initiativeId = src.initiativeId;
    delete db.items[sid];
  }
  target.updatedAt = new Date().toISOString();
  return target;
}

module.exports = { STATUSES, BUCKETS, load, save, newId, sessionOwners, projectLabel, titleFor, baseItem, ensureItem, mergeItems, empty };
