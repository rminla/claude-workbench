'use strict';
// Joins the derived session index with the overlay into rows the UI renders.
// Sessions with no overlay row appear as VIRTUAL items so nothing is ever hidden
// just because it hasn't been triaged yet.

const { loadIndex } = require('./indexer');

// Cron/SDK runs are excluded from the board: a machine execution has no status
// to triage, and they would otherwise mint an overlay row per run forever.
// They stay indexed — set WORKBENCH_INCLUDE_AUTOMATED=1 to surface them again.
const INCLUDE_AUTOMATED = process.env.WORKBENCH_INCLUDE_AUTOMATED === '1';
const store = require('./store');
const initiatives = require('./initiatives');

function sessionSummary(s) {
  return {
    sessionId: s.sessionId,
    title: store.titleFor(s),
    aiTitle: s.aiTitle || null,
    customTitle: s.customTitle || null,
    firstPrompt: s.firstPrompt || null,
    lastPrompt: s.lastPrompt || null,
    cwd: s.cwd || null,
    branch: s.branch || null,
    project: store.projectLabel(s),
    started: s.started || null,
    lastActivity: s.lastActivity || null,
    userMsgs: s.userMsgs || 0,
    assistantMsgs: s.assistantMsgs || 0,
    entrypoint: s.entrypoint || null,
    headless: s.entrypoint === 'sdk-cli',
    sizeMB: s.size ? +(s.size / 1048576).toFixed(1) : 0,
  };
}

function build() {
  const idx = loadIndex();
  const db = store.load();
  const iniDb = initiatives.load();
  const active = iniDb.initiatives.filter((i) => !i.archived);
  const owners = store.sessionOwners(db);

  const sessions = {};
  for (const s of Object.values(idx.sessions)) {
    if (!s || !s.sessionId || s.error) continue;
    if (!(s.userMsgs > 0)) continue; // no real human prompt -> nothing to track
    if (!INCLUDE_AUTOMATED && s.entrypoint === 'sdk-cli') continue;
    sessions[s.sessionId] = sessionSummary(s);
  }

  const rows = [];

  // 1. Persisted items (may own several sessions after a merge).
  for (const it of Object.values(db.items)) {
    const owned = (it.sessionIds || []).map((id) => sessions[id]).filter(Boolean);
    if (!owned.length) {
      rows.push(makeRow(it, [], false));
      continue;
    }
    owned.sort((a, b) => Date.parse(b.lastActivity || 0) - Date.parse(a.lastActivity || 0));
    rows.push(makeRow(it, owned, false));
  }

  // 2. Untracked sessions -> virtual inbox items.
  for (const s of Object.values(sessions)) {
    if (owners[s.sessionId]) continue;
    rows.push(makeRow(store.baseItem({ id: 'v:' + s.sessionId, sessionIds: [s.sessionId] }), [s], true));
  }

  // Resolve each row's initiative: explicit assignment wins, else classify.
  for (const r of rows) {
    if (r.initiativeId) { r.initiativeAuto = false; continue; }
    const hay = [r.title, r.note, (r.tags || []).join(' '), r.project,
      ...r.sessions.map((s) => (s.aiTitle || '') + ' ' + (s.firstPrompt || ''))].join(' ');
    const c = initiatives.classify(hay, active);
    r.initiativeId = c.id;
    r.initiativeAuto = true;
    r.initiativeScore = c.score;
  }

  rows.sort((a, b) => Date.parse(b.lastActivity || 0) - Date.parse(a.lastActivity || 0));

  return { rows, initiatives: iniDb.initiatives, indexUpdatedAt: idx.updatedAt, sessionCount: Object.keys(sessions).length, includeAutomated: INCLUDE_AUTOMATED };
}

// A session started from the workbench has an item before it has a transcript.
// Say so, rather than showing the "(no sessions)" of a genuinely empty item.
function pendingTitle(it) {
  if (!it.cwd) return '(no sessions)';
  return 'Starting in ' + require('path').basename(it.cwd) + '…';
}

function makeRow(it, owned, virtual) {
  const newest = owned[0] || null;
  const lastActivity = owned.reduce((acc, s) => {
    const t = Date.parse(s.lastActivity || 0) || 0;
    return t > acc ? t : acc;
  }, 0);
  return {
    id: it.id,
    virtual,
    sessionIds: it.sessionIds || [],
    title: it.title || (newest ? newest.title : pendingTitle(it)),
    customTitle: !!it.title,
    status: it.status,
    bucket: it.bucket,
    assignee: it.assignee || null,
    tags: it.tags || [],
    note: it.note || '',
    jiraKey: it.jiraKey || null,
    initiativeId: it.initiativeId || null,
    needsWrapUp: !!it.needsWrapUp,
    wrapReason: it.wrapReason || null,
    wrapScore: it.wrapScore || 0,
    endedAt: it.endedAt || null,
    endReason: it.endReason || null,
    project: (newest && newest.project) || null,
    branch: (newest && newest.branch) || null,
    cwd: (newest && newest.cwd) || it.cwd || null,
    headless: !!(newest && newest.headless),
    userMsgs: owned.reduce((a, s) => a + s.userMsgs, 0),
    assistantMsgs: owned.reduce((a, s) => a + s.assistantMsgs, 0),
    started: owned.length ? owned[owned.length - 1].started : null,
    lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
    sessions: owned,
    sessionCount: owned.length,
    updatedAt: it.updatedAt,
  };
}

module.exports = { build };
