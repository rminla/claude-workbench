'use strict';
const $ = (s) => document.querySelector(s);
function el(t, a, kids) {
  const n = document.createElement(t);
  for (const k in (a || {})) {
    const v = a[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(kids || [])) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}

const STATUS_LABEL = { inbox: 'Not started', active: 'Working on it', paused: 'Paused', blocked: 'Stuck', done: 'Done', dropped: 'Dropped' };
const BUCKET_LABEL = { now: 'Now', next: 'Next', someday: 'Someday' };
const COLORS = ['violet','teal','blue','amber','cyan','indigo','lime','red','orange','pink','emerald','yellow','slate','fuchsia','stone'];

const S = {
  rows: [], inits: [], live: [], statuses: [], buckets: [],
  q: '', view: 'all', initFilter: null, owner: '', sort: 'recent',
  openMode: 'active',
  statusFilter: new Set(), picked: new Set(), collapsed: new Set(JSON.parse(localStorage.getItem('wb-collapsed') || '[]')),
  drawer: null, peek: {}, mode: 'board', workQ: '',
};

function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'now';
  const m = s / 60; if (m < 60) return Math.round(m) + 'm';
  const h = m / 60; if (h < 24) return Math.round(h) + 'h';
  const d = h / 24; if (d < 7) return Math.round(d) + 'd';
  const w = d / 7; if (w < 5) return Math.round(w) + 'w';
  return Math.round(d / 30) + 'mo';
}
function initials(n) {
  const p = String(n).trim().split(/[\s._-]+/).filter(Boolean);
  return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
}
window.WBToast = (m) => toast(m);
window.WBReload = () => load();
// Ending live work deserves a question, but not a modal: a browser confirm()
// steals focus from the terminal and blocks the page while a turn is running.
window.WBConfirm = (rect, text, label, onYes) => openMenu(rect, [
  el('div', { class: 'mhint', text }),
  el('button', { class: 'mdanger', text: label, onclick: () => { closeMenu(); onYes(); } }),
  el('button', { text: 'Cancel', onclick: () => closeMenu() }),
]);
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2400);
}
async function api(p, o) {
  const r = await fetch(p, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const initById = (id) => S.inits.find((i) => i.id === id);
const colorOf = (id) => `var(--c-${(initById(id) || {}).color || 'none'})`;

async function load() {
  const d = await api('/api/rows');
  // Frontend files changed under a long-lived page — stale handlers are worse
  // than a reload, which costs nothing here: tabs re-attach on boot.
  if (S.assetStamp && d.assetStamp && d.assetStamp !== S.assetStamp) { location.reload(); return; }
  S.assetStamp = d.assetStamp || S.assetStamp;
  S.rows = d.rows; S.inits = (d.initiatives || []).filter((i) => !i.archived).sort((a, b) => (a.order || 0) - (b.order || 0));
  S.live = d.live || []; S.idle = d.idle || []; S.restore = d.restore || []; S.statuses = d.statuses; S.buckets = d.buckets; S.stamp = d.indexUpdatedAt;
  syncTabTitles();
  render();
  if (!S.booted) { S.booted = true; openLiveSessions(); }
}

// On a fresh page the running sessions are the whole point — attach to every
// one, most recently active last so it ends up in front. Sessions that were open
// when the machine went down come back too: tmux died with it, the server's
// record did not, and opening the tab resumes claude in a new tmux.
function openLiveSessions() {
  const T = window.WBTerm;
  if (!T) return;
  const open = [];
  S.rows.filter(isLive).forEach((r) => {
    // the item may own several sessions; attach to the one that is running
    const ids = [...(r.sessionIds || []), ...(r.sessions || []).map((x) => x.sessionId)];
    const id = ids.find((x) => S.live.includes('wb_' + x.slice(0, 8)));
    const s = (r.sessions || []).find((x) => x.sessionId === id) || (id ? { sessionId: id, cwd: r.cwd, title: r.title } : null);
    if (s) open.push({ s, at: r.lastActivity });
  });
  (S.restore || []).forEach((x) => {
    const r = rowForSession(x.sessionId);
    open.push({ s: { sessionId: x.sessionId, cwd: x.cwd || (r && r.cwd), title: r ? r.title : x.sessionId.slice(0, 8) },
      at: r && r.lastActivity });
  });
  open.sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0)).forEach((o) => T.open(o.s));
  if (open.length) workRail();
}

// A tab is named at open time, before the session has a transcript or a title.
// Re-point it at the board row on every refresh so an ai-title landing, or a
// rename in either place, shows up in the rail instead of "New session" forever.
function syncTabTitles() {
  const T = window.WBTerm;
  if (!T || !T.setTitle) return;
  T.tabs.forEach((t) => {
    const r = rowForSession(t.id);
    if (r) T.setTitle(t.id, r.title);
  });
}

// Match on the item's own session list: a session started here has an item
// before it has an indexed transcript, so r.sessions is still empty.
function rowForSession(sessionId) {
  return S.rows.find((r) => (r.sessionIds || []).includes(sessionId))
      || S.rows.find((r) => r.sessions.some((x) => x.sessionId === sessionId));
}

const isLive = (r) => (r.sessions || []).some((s) => (S.live || []).includes('wb_' + s.sessionId.slice(0, 8)))
  || (r.sessionIds || []).some((id) => (S.live || []).includes('wb_' + id.slice(0, 8)));

// Three states worth telling apart in the rail, because they call for different
// things from you: working (leave it alone), waiting (it needs a reply), stopped
// (claude exited — the tab is a shell now).
function agentState(t) {
  const T = window.WBTerm;
  if (t.status !== 'live') return { cls: 'gone', label: t.status === 'connecting' ? 'Connecting…' : 'Disconnected' };
  if (T && T.isBusy && T.isBusy(t)) return { cls: 'busy', label: 'Working…' };
  const row = rowForSession(t.id);
  if (row && !isLive(row)) return { cls: 'gone', label: 'claude has exited — this is a shell' };
  return { cls: 'idle', label: 'Waiting for you' };
}

function agentDot(t) {
  const st = agentState(t);
  return el('span', { class: 'dot agent ' + st.cls, title: st.label });
}

// The dot has to keep up with the terminal, not with the 30s board refresh, so it
// repaints in place — rebuilding the rail on a timer would fight with hover.
function paintAgentDots() {
  const T = window.WBTerm;
  if (!T || S.mode !== 'work') return;
  T.tabs.forEach((t) => {
    const node = document.querySelector('.wtab[data-sid="' + CSS.escape(t.id) + '"] .dot.agent');
    if (!node) return;
    const st = agentState(t);
    if (node.classList.contains(st.cls)) return;
    node.className = 'dot agent ' + st.cls;
    node.title = st.label;
  });
}

// The session a row points at, even before the transcript exists.
function sessionOf(r) {
  if (!r) return null;
  if (r.sessions && r.sessions.length) return r.sessions[0];
  const id = (r.sessionIds || [])[0];
  return id ? { sessionId: id, cwd: r.cwd, title: r.title } : null;
}

/* ── filtering ─────────────────────────────────────────────────────── */
function base() { return S.rows; }  // automated runs are filtered out server-side

function filtered() {
  const q = S.q.trim().toLowerCase();
  return base().filter((r) => {
    if (S.view !== 'wrapup' && S.openMode === 'active' && (r.status === 'done' || r.status === 'dropped')) return false;
    if (S.view === 'wrapup' && !r.needsWrapUp) return false;
    if (S.view === 'unsorted' && r.initiativeId) return false;
    if (S.view === 'mine' && r.assignee) return false;
    if (S.initFilter && r.initiativeId !== S.initFilter) return false;
    if (S.statusFilter.size && !S.statusFilter.has(r.status)) return false;
    if (S.owner && (r.assignee || '') !== S.owner) return false;
    if (!q) return true;
    return [r.title, r.note, r.jiraKey, r.assignee, r.project, (r.tags || []).join(' '),
      ...r.sessions.map((s) => (s.firstPrompt || '') + ' ' + s.title)].join(' ').toLowerCase().includes(q);
  }).sort(S.view === 'wrapup'
    ? (a, b) => (b.wrapScore || 0) - (a.wrapScore || 0) || Date.parse(b.lastActivity || 0) - Date.parse(a.lastActivity || 0)
    : {
    recent: (a, b) => Date.parse(b.lastActivity || 0) - Date.parse(a.lastActivity || 0),
    oldest: (a, b) => Date.parse(a.lastActivity || 0) - Date.parse(b.lastActivity || 0),
    name: (a, b) => a.title.localeCompare(b.title),
    effort: (a, b) => (b.userMsgs + b.assistantMsgs) - (a.userMsgs + a.assistantMsgs),
  }[S.sort]);
}

/* ── render ────────────────────────────────────────────────────────── */
function setMode(m) {
  if (m === S.mode) return;
  S.mode = m;
  document.body.dataset.mode = m;
  $('#sideBoard').hidden = m === 'work';
  $('#sideWork').hidden = m !== 'work';
  // the global [hidden] rule is !important, so the attribute must come off
  $('#workbar').hidden = m !== 'work';
  $('#modeSwap').textContent = m === 'work' ? 'Board ⇥' : 'Work ⇥';
  if (window.WBTerm) {
    if (m === 'work') { WBTerm.show(); }
    WBTerm.applyHeight();
    setTimeout(() => WBTerm.fit(), 80);
  }
  render();
}

function render() { S.mode === 'work' ? workRail() : sidebar(); board(); bulkbar(); }

// Sidebar while working: what's live, and what you could start next.
function workRail() {
  const T = window.WBTerm;
  const tabs = T ? T.tabs : [];
  $('#workCount').textContent = tabs.length ? String(tabs.length) : '';

  const idle = (S.idle || []).length;
  const host = $('#workTabs'); host.innerHTML = '';
  if (idle) {
    host.appendChild(el('button', {
      class: 'nav', style: 'color:var(--ink-3)',
      title: 'tmux containers whose claude process has exited',
      onclick: async () => {
        try { const r = await api('/api/prune', { method: 'POST' }); toast(`Cleared ${r.killed.length} finished`); load(); }
        catch (e) { toast('Failed: ' + e.message); }
      },
    }, [el('span', { class: 'dot', style: '--dot: var(--ink-3)' }),
        el('span', { class: 'nm', text: `${idle} finished — clear` })]));
  }
  if (!tabs.length) {
    host.appendChild(el('div', { style: 'padding:6px 9px;font-size:12.5px;color:var(--ink-3)', text: 'Nothing open yet.' }));
  }
  tabs.forEach((t) => {
    const row = rowForSession(t.id);
    host.appendChild(el('button', {
      class: 'nav wtab', 'aria-current': String(t.id === T.active), 'data-sid': t.id,
      onclick: () => { T.activate(t.id); workRail(); workHeader(); },
    }, [
      agentDot(t),
      el('span', { class: 'nm' }, [
        el('span', { text: (row && row.title) || t.title }),
        el('span', { class: 'sub2', text: (row && row.project) || t.session.cwd || '' }),
      ]),
      el('button', { class: 'tx tx2', text: '✓', title: 'Wrap up — set status, optionally end it',
        onclick: (e) => { e.stopPropagation(); if (row) wrapMenu(e, row, { offerEnd: true }); else toast('No item for this session'); } }),
      el('button', { class: 'tx', text: '✕', title: 'End this session (⌥ to detach and leave it running)',
        onclick: (e) => {
          e.stopPropagation();
          const at = e.currentTarget.getBoundingClientRect();
          if (e.altKey) { T.closeTab(t.id); workRail(); workHeader(); return; }
          T.endTab(t.id, at);
        } }),
    ]));
  });

  // candidates to start
  const openIds = new Set(tabs.map((t) => t.id));
  const q = S.workQ.trim().toLowerCase();
  const cands = S.rows
    .filter((r) => r.status !== 'done' && r.status !== 'dropped')
    .filter((r) => !r.sessions.every((s) => openIds.has(s.sessionId)))
    .filter((r) => !q || r.title.toLowerCase().includes(q) || (r.project || '').toLowerCase().includes(q))
    .slice(0, 40);

  const pick = $('#workPick'); pick.innerHTML = '';
  cands.forEach((r) => pick.appendChild(el('button', {
    class: 'nav wtab', title: r.title,
    onclick: () => openTerm(sessionOf(r)),
  }, [
    el('span', { class: 'dot', style: `--dot: ${r.initiativeId ? colorOf(r.initiativeId) : 'var(--c-none)'}` }),
    el('span', { class: 'nm' }, [
      isLive(r) ? el('span', { class: 'livedot', title: 'claude is running in this session' }) : null,
      el('span', { text: r.title }),
      el('span', { class: 'sub2', text: [r.project || '', ago(r.lastActivity)].filter(Boolean).join(' · ') }),
    ]),
  ])));
  if (!cands.length) pick.appendChild(el('div', { style: 'padding:6px 9px;font-size:12.5px;color:var(--ink-3)', text: q ? 'No match.' : 'Everything open is already running.' }));

  workHeader();
}

function workHeader() {
  const T = window.WBTerm;
  const a = T && T.tabs.find((t) => t.id === T.active);
  const ar = a ? rowForSession(a.id) : null;
  $('#workTitle').textContent = a ? ((ar && ar.title) || a.title) : 'No session open';
  $('#workMeta').textContent = a ? [a.tmux || '', a.session.cwd || ''].filter(Boolean).join('  ·  ') : 'Pick something from the left to start';
}

function sidebar() {
  const all = base();
  const open = all.filter((r) => r.status !== 'done' && r.status !== 'dropped');
  const views = [
    ['all', 'All work', open.length],
    ['wrapup', 'Needs wrap-up', all.filter((r) => r.needsWrapUp).length],
    ['unsorted', 'Unsorted', open.filter((r) => !r.initiativeId).length],
    ['mine', 'Unassigned', open.filter((r) => !r.assignee).length],
  ];
  const nv = $('#views'); nv.innerHTML = '';
  views.forEach(([id, label, n]) => nv.appendChild(el('button', {
    class: 'nav', 'aria-current': String(S.view === id && !S.initFilter),
    onclick: () => { S.view = id; S.initFilter = null; render(); },
  }, [el('span', { class: 'dot', style: `--dot: var(--c-${id === 'all' ? 'blue' : id === 'unsorted' ? 'amber' : 'slate'})` }),
      el('span', { class: 'nm', text: label }), el('span', { class: 'ct', text: String(n) })])));

  const ni = $('#inits'); ni.innerHTML = '';
  S.inits.forEach((i) => {
    const n = open.filter((r) => r.initiativeId === i.id).length;
    ni.appendChild(el('button', {
      class: 'nav', 'aria-current': String(S.initFilter === i.id), title: i.hint || '',
      onclick: () => { S.initFilter = S.initFilter === i.id ? null : i.id; S.view = 'all'; render(); },
    }, [el('span', { class: 'dot', style: `--dot: var(--c-${i.color})` }),
        el('span', { class: 'nm', text: i.name }), el('span', { class: 'ct', text: String(n) })]));
  });
  $('#stamp').textContent = 'idx ' + ago(S.stamp);
}

function board() {
  if (S.mode === 'work') return;
  const rows = filtered();
  const it = S.initFilter ? initById(S.initFilter) : null;
  $('#boardTitle').textContent = it ? it.name
    : S.view === 'unsorted' ? 'Unsorted'
    : S.view === 'mine' ? 'Unassigned'
    : S.view === 'wrapup' ? 'Needs wrap-up' : 'All work';
  $('#boardSub').textContent = S.view === 'wrapup'
    ? 'These sessions ended without you saying where they landed.'
    : (it && it.hint ? it.hint : `${rows.length} item${rows.length === 1 ? '' : 's'}`);

  const b = $('#board'); b.innerHTML = '';
  if (!rows.length) {
    b.appendChild(el('div', { class: 'empty' }, [
      el('strong', { text: 'Nothing here' }),
      el('div', { text: 'Try "Everything" to include finished work, or clear the filters.' }),
    ]));
    return;
  }

  // group by initiative (single group when one is selected)
  const groups = new Map();
  rows.forEach((r) => {
    const k = r.initiativeId || '__none';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const order = S.inits.map((i) => i.id).filter((id) => groups.has(id));
  if (groups.has('__none')) order.push('__none');

  order.forEach((gid) => b.appendChild(groupEl(gid, groups.get(gid))));
}

function groupEl(gid, items) {
  const ini = initById(gid);
  const acc = gid === '__none' ? 'var(--c-none)' : `var(--c-${ini.color})`;
  const collapsed = S.collapsed.has(gid);
  const allOfGroup = base().filter((r) => (r.initiativeId || '__none') === gid);
  const doneN = allOfGroup.filter((r) => r.status === 'done' || r.status === 'dropped').length;
  const totalN = allOfGroup.length;

  const wrap = el('section', { class: 'group' + (collapsed ? ' collapsed' : ''), style: `--acc: ${acc}` });

  const nameNode = ini
    ? el('button', { class: 'group-name', contenteditable: 'true', spellcheck: 'false', text: ini.name,
        onblur: (e) => {
          const v = e.target.textContent.trim();
          if (v && v !== ini.name) api('/api/initiatives', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', initiative: { ...ini, name: v } }) }).then(load);
        },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } } })
    : el('span', { class: 'group-name', text: 'Unsorted' });

  wrap.appendChild(el('div', { class: 'group-bar' }, [
    el('button', { class: 'caret', text: '▾', title: 'Collapse',
      onclick: () => { collapsed ? S.collapsed.delete(gid) : S.collapsed.add(gid);
        localStorage.setItem('wb-collapsed', JSON.stringify([...S.collapsed])); render(); } }),
    nameNode,
    el('span', { class: 'group-count', text: String(items.length) }),
    el('span', { class: 'progress', title: `${doneN} of ${totalN} closed` }, [
      el('i', { style: `width:${totalN ? (doneN / totalN) * 100 : 0}%` })]),
    el('span', { class: 'group-hint', style: 'flex:none', text: `${Math.round(totalN ? (doneN / totalN) * 100 : 0)}%` }),
    el('span', { class: 'group-hint', text: ini ? (ini.hint || '') : 'No initiative matched — assign these' }),
    el('span', { class: 'grow' }),
    ini ? el('button', { class: 'btn ghost sm', text: '⋯', onclick: (e) => initMenu(e, ini) }) : null,
  ]));

  const table = el('div', { class: 'tablewrap' });
  table.appendChild(el('div', { class: 'thead' }, [
    el('div'), el('div'), el('div', { text: 'Item' }),
    el('div', { class: 'th-c', text: 'Owner' }),
    el('div', { class: 'th-c', text: 'Status' }),
    el('div', { class: 'th-c h-pri', text: 'Priority' }),
    el('div', { class: 'th-c h-when', text: 'Touched' }),
    el('div'),
  ]));
  items.forEach((r) => table.appendChild(rowEl(r, acc)));
  wrap.appendChild(table);
  return wrap;
}

function rowEl(r, acc) {
  const live = r.sessions.some((s) => S.live.includes('wb_' + s.sessionId.slice(0, 8)));
  const row = el('div', { class: `trow ${r.status}` + (S.picked.has(r.id) ? ' picked' : ''), style: `--acc: ${acc}` });

  row.appendChild(el('div', {}, [el('input', {
    class: 'pick', type: 'checkbox', checked: S.picked.has(r.id) ? 'checked' : null,
    onchange: (e) => { e.target.checked ? S.picked.add(r.id) : S.picked.delete(r.id); render(); },
  })]));
  row.appendChild(el('div', { class: 'accent' }));

  row.appendChild(el('div', { class: 'cell' }, [
    el('div', { class: 'tname', onclick: () => { S.drawer = r.id; drawer(r); } }, [
      live ? el('span', { class: 'livedot', title: 'tmux session live' }) : null,
      el('span', { class: 'txt', text: r.title }),
      r.sessionCount > 1 ? el('span', { class: 'chip-n', text: r.sessionCount + '×' }) : null,
      r.jiraKey ? el('span', { class: 'chip-n', text: r.jiraKey }) : null,
      r.note ? el('span', { class: 'sub', text: '✎' }) : null,
      r.needsWrapUp && r.wrapReason && S.view === 'wrapup'
        ? el('span', { class: 'wrapwhy', text: r.wrapReason }) : null,
      r.needsWrapUp ? el('button', { class: 'wrapflag', text: 'wrap up',
        title: 'Ended ' + ago(r.endedAt) + ' ago without a status — click to set one',
        onclick: (e) => { e.stopPropagation(); wrapMenu(e, r, { offerEnd: false }); } }) : null,
    ]),
  ]));

  row.appendChild(el('div', { class: 'cell c' }, [
    el('button', {
      class: 'who' + (r.assignee ? '' : ' na'), text: r.assignee ? initials(r.assignee) : '+',
      title: r.assignee || 'Assign', onclick: (e) => ownerMenu(e, r),
    }),
  ]));

  row.appendChild(el('div', { class: 'cell' }, [
    el('button', { class: 'pill', style: `background: var(--st-${r.status})`, text: STATUS_LABEL[r.status],
      onclick: (e) => statusMenu(e, r) }),
  ]));

  row.appendChild(el('div', { class: 'cell c-pri' }, [
    el('button', { class: 'pill', style: `background: var(--pr-${r.bucket})`, text: BUCKET_LABEL[r.bucket],
      onclick: (e) => bucketMenu(e, r) }),
  ]));

  row.appendChild(el('div', { class: 'cell c-when' }, [el('div', { class: 'when', text: ago(r.lastActivity) })]));

  row.appendChild(el('div', { class: 'cell' }, [
    el('div', { class: 'rowact' }, [
      el('button', { class: 'btn sm', text: '▶', title: 'Open terminal here', onclick: () => openTerm(sessionOf(r)) }),
      el('button', { class: 'btn sm', text: '⋯', title: 'Move / more', onclick: (e) => rowMenu(e, r) }),
    ]),
  ]));
  return row;
}

/* ── menus ─────────────────────────────────────────────────────────── */
let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
document.addEventListener('click', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);

function openMenu(anchor, kids) {
  closeMenu();
  // `anchor` may be an event or an element. An event's currentTarget is null once
  // the dispatch finishes, so any async caller must pass the element itself.
  // A caller replacing one menu with another must pass a RECT: closeMenu() has
  // already detached its button, and a detached element measures as all zeros.
  const rect = anchor && typeof anchor.bottom === 'number' ? anchor : null;
  const node = anchor && anchor.nodeType === 1 ? anchor
    : (anchor && (anchor.currentTarget || anchor.target)) || null;
  const m = el('div', { class: 'menu' }, kids);
  document.body.appendChild(m);
  const r = rect || (node && node.getBoundingClientRect
    ? node.getBoundingClientRect()
    : { bottom: 80, left: 80 });
  const h = m.offsetHeight, w = m.offsetWidth;
  m.style.top = Math.min(r.bottom + 6, window.innerHeight - h - 10) + 'px';
  m.style.left = Math.min(r.left, window.innerWidth - w - 10) + 'px';
  menuEl = m;
  const inp = m.querySelector('input'); if (inp) inp.focus();
  return m;
}

function patch(r, p) {
  return api('/api/item', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: r.id, patch: p }) })
    .then((res) => { if (S.drawer === r.id) S.drawer = res.id; closeMenu(); return load(); });
}
function bulkPatch(p) {
  return api('/api/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [...S.picked], patch: p }) })
    .then((res) => { toast(`Updated ${res.updated}`); S.picked.clear(); closeMenu(); return load(); });
}

// The only moment status is reliably knowable is when a person closes the work,
// so make saying it cheap: one click, optional note, optional kill.
function wrapMenu(ev, r, opts) {
  const o = opts || {};
  const note = el('input', { placeholder: 'Optional: where it stands…' });
  const endBox = el('input', { type: 'checkbox', checked: o.offerEnd ? 'checked' : null });
  const submit = (status) => api('/api/wrapup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: r.id, status, note: note.value, end: o.offerEnd ? endBox.checked : false }),
  }).then((res) => {
    closeMenu();
    toast('Marked ' + STATUS_LABEL[status] + (res.ended && res.ended.some((e) => e.killed) ? ' · session ended' : ''));
    if (o.offerEnd && endBox.checked && window.WBTerm) {
      r.sessions.forEach((sn) => window.WBTerm.closeTab(sn.sessionId));
    }
    return load();
  }).catch((e) => toast('Failed: ' + e.message));

  const kids = [
    el('div', { style: 'font-size:11px;color:var(--ink-3);padding:4px 10px 6px;letter-spacing:.06em;text-transform:uppercase', text: 'Where did this land?' }),
    ...['done', 'paused', 'blocked', 'dropped'].map((st) => el('button', { onclick: () => submit(st) }, [
      el('span', { class: 'swatch', style: `background: var(--st-${st})` }), STATUS_LABEL[st]])),
    el('hr'), note,
  ];
  if (o.offerEnd) {
    kids.push(el('label', { style: 'display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12.5px;color:var(--ink-2)' },
      [endBox, 'Also end the tmux session']));
  }
  openMenu(ev, kids);
}

function statusMenu(ev, r) {
  openMenu(ev, S.statuses.map((s) => el('button', { onclick: () => patch(r, { status: s }) }, [
    el('span', { class: 'swatch', style: `background: var(--st-${s})` }), STATUS_LABEL[s]])));
}
function bucketMenu(ev, r) {
  openMenu(ev, S.buckets.map((b) => el('button', { onclick: () => patch(r, { bucket: b }) }, [
    el('span', { class: 'swatch', style: `background: var(--pr-${b})` }), BUCKET_LABEL[b]])));
}
function ownerMenu(ev, r) {
  const people = [...new Set(S.rows.map((x) => x.assignee).filter(Boolean))].sort();
  const input = el('input', { placeholder: 'Name, then Enter', value: r.assignee || '',
    onkeydown: (e) => { if (e.key === 'Enter') patch(r, { assignee: e.target.value.trim() }); } });
  openMenu(ev, [input, ...people.map((p) => el('button', { onclick: () => patch(r, { assignee: p }) }, [
    el('span', { class: 'swatch', style: 'background: var(--brand); border-radius:50%' }), p])),
    el('hr'), el('button', { text: 'Clear owner', onclick: () => patch(r, { assignee: '' }) })]);
}
// A name typed here is the item's own; it outranks whatever the transcript
// later calls itself, which is the point of bothering to type one.
function renameMenu(ev, r, seed) {
  const input = el('input', { placeholder: 'Name this work', value: r.title || seed || '',
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      const v = e.target.value.trim();
      if (window.WBTerm && window.WBTerm.setTitle) {
        for (const sid of r.sessionIds || []) window.WBTerm.setTitle(sid, v || r.title);
      }
      patch(r, { title: v || null });
    } });
  openMenu(ev, [input, el('hr'),
    el('button', { text: 'Use the session’s own title',
      onclick: () => adoptSessionTitle(r).catch((e) => toast('Failed: ' + e.message)) })]);
}

// "The session's own title" is only true after a reindex: /rename writes into
// the transcript, which the index hasn't re-read yet — clearing the override
// against stale data re-applies the old name and looks like a no-op.
async function adoptSessionTitle(r) {
  const was = r.title || (r.sessions[0] && r.sessions[0].title) || null;
  const sid = (r.sessionIds || [])[0] || (r.sessions[0] && r.sessions[0].sessionId);
  await api('/api/reindex', { method: 'POST' });
  await patch(r, { title: null });
  const now = (sid && rowForSession(sid)) || S.rows.find((x) => x.id === r.id);
  const t = now && now.title;
  toast(t && t !== was ? 'Renamed: ' + t : 'Already current: ' + (t || was || ''));
  return t;
}

function rowMenu(ev, r) {
  openMenu(ev, [
    el('div', { style: 'font-size:11px;color:var(--ink-3);padding:6px 10px;letter-spacing:.06em;text-transform:uppercase' }, ['Move to initiative']),
    ...S.inits.map((i) => el('button', { onclick: () => patch(r, { initiativeId: i.id }) }, [
      el('span', { class: 'swatch', style: `background: var(--c-${i.color})` }), i.name])),
    el('hr'),
    el('button', { text: 'Open terminal', onclick: () => { closeMenu(); openTerm(sessionOf(r)); } }),
    el('button', { text: 'Open in iTerm', onclick: () => { closeMenu(); launch(sessionOf(r), false); } }),
    el('button', { text: 'Fork into terminal', onclick: () => { closeMenu(); openTerm(sessionOf(r), { fork: true }); } }),
    el('button', { text: 'Rename…', onclick: (e) => { const at = e.currentTarget.getBoundingClientRect(); closeMenu(); renameMenu(at, r); } }),
    el('button', { text: 'Wrap up…', onclick: (e) => { closeMenu(); wrapMenu(e, r, { offerEnd: true }); } }),
    el('button', { text: 'Open details', onclick: () => { closeMenu(); S.drawer = r.id; drawer(r); } }),
  ]);
}
function initMenu(ev, ini) {
  openMenu(ev, [
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;padding:6px' }, COLORS.map((c) =>
      el('button', { title: c, style: `width:20px;height:20px;padding:0;border-radius:6px;background:var(--c-${c})`,
        onclick: () => api('/api/initiatives', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'save', initiative: { ...ini, color: c } }) }).then(() => { closeMenu(); load(); }) }))),
    el('hr'),
    el('button', { text: 'Archive initiative', onclick: () => api('/api/initiatives', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'archive', id: ini.id }) }).then(() => { closeMenu(); toast('Archived'); load(); }) }),
  ]);
}

/* ── drawer ────────────────────────────────────────────────────────── */
function drawer(r) {
  closeDrawer();
  const ini = initById(r.initiativeId);
  const acc = r.initiativeId ? `var(--c-${ini.color})` : 'var(--c-none)';
  const scrim = el('div', { class: 'scrim', onclick: closeDrawer });
  const d = el('aside', { class: 'drawer', style: `--acc: ${acc}` });

  d.appendChild(el('div', { class: 'drawer-head' }, [
    el('div', { class: 'eyebrow' }, [
      el('span', { class: 'dot', style: `width:9px;height:9px;border-radius:3px;background:${acc};display:inline-block` }),
      ini ? ini.name : 'Unsorted',
      r.initiativeAuto ? el('span', { style: 'color:var(--ink-3);font-weight:400', text: '· auto-grouped' }) : null,
      el('span', { class: 'grow' }),
      el('button', { class: 'btn ghost sm', text: '✕', onclick: closeDrawer }),
    ]),
    el('h3', { text: r.title }),
  ]));

  const b = el('div', { class: 'drawer-body' });
  b.appendChild(el('div', { class: 'dsec', text: 'Properties' }));
  const g = el('div', { class: 'grid2' });
  const mkSel = (label, opts, cur, key, fmt) => {
    const s = el('select');
    opts.forEach((o) => s.appendChild(el('option', { value: o, text: fmt ? fmt[o] : o, selected: o === cur ? 'selected' : null })));
    s.addEventListener('change', () => patch(r, { [key]: s.value }));
    g.appendChild(el('label', { class: 'fld' }, [el('span', { text: label }), s]));
  };
  mkSel('Status', S.statuses, r.status, 'status', STATUS_LABEL);
  mkSel('Priority', S.buckets, r.bucket, 'bucket', BUCKET_LABEL);
  const isel = el('select');
  isel.appendChild(el('option', { value: '', text: '— Unsorted —', selected: r.initiativeId ? null : 'selected' }));
  S.inits.forEach((i) => isel.appendChild(el('option', { value: i.id, text: i.name, selected: i.id === r.initiativeId ? 'selected' : null })));
  isel.addEventListener('change', () => patch(r, { initiativeId: isel.value || null }));
  g.appendChild(el('label', { class: 'fld' }, [el('span', { text: 'Initiative' }), isel]));

  const own = el('input', { value: r.assignee || '', placeholder: 'unassigned' });
  own.addEventListener('change', () => patch(r, { assignee: own.value.trim() }));
  g.appendChild(el('label', { class: 'fld' }, [el('span', { text: 'Owner' }), own]));

  const tg = el('input', { value: (r.tags || []).join(', '), placeholder: 'bug, idea' });
  tg.addEventListener('change', () => patch(r, { tags: tg.value.split(',').map((s) => s.trim()).filter(Boolean) }));
  g.appendChild(el('label', { class: 'fld' }, [el('span', { text: 'Tags' }), tg]));

  const jk = el('input', { value: r.jiraKey || '', placeholder: 'OUT-1234' });
  jk.addEventListener('change', () => patch(r, { jiraKey: jk.value.trim().toUpperCase() }));
  g.appendChild(el('label', { class: 'fld' }, [el('span', { text: 'Jira' }), jk]));
  b.appendChild(g);

  b.appendChild(el('div', { class: 'dsec', text: 'Note' }));
  const note = el('textarea', { rows: '4', placeholder: 'Where you left off, next step, blocker…' });
  note.value = r.note || '';
  note.addEventListener('change', () => patch(r, { note: note.value }));
  b.appendChild(el('label', { class: 'fld' }, [note]));

  b.appendChild(el('div', { class: 'dsec', text: `Sessions (${r.sessionCount})` }));
  r.sessions.forEach((s) => {
    const card = el('div', { class: 'scard' });
    card.appendChild(el('div', { class: 'top' }, [
      el('code', { text: s.sessionId.slice(0, 8) }),
      el('span', { class: 'nm', text: s.title }),
      el('span', { class: 'when', text: ago(s.lastActivity) }),
      el('button', { class: 'btn sm', text: 'Terminal', onclick: () => openTerm(s) }),
      el('button', { class: 'btn sm', text: 'iTerm', title: 'Open in iTerm instead', onclick: () => launch(s, false) }),
      el('button', { class: 'btn sm', text: S.peek[s.sessionId] ? 'Hide' : 'Peek', onclick: async () => {
        if (S.peek[s.sessionId]) { delete S.peek[s.sessionId]; return drawer(r); }
        const j = await api('/api/transcript?sessionId=' + encodeURIComponent(s.sessionId));
        S.peek[s.sessionId] = j.messages; drawer(r);
      } }),
    ]));
    if (s.firstPrompt) card.appendChild(el('div', { class: 'pr', text: s.firstPrompt }));
    if (s.cwd) card.appendChild(el('div', { class: 'when', style: 'text-align:left;margin-top:5px', text: s.cwd }));
    if (S.peek[s.sessionId]) {
      card.appendChild(el('div', { class: 'peek' }, S.peek[s.sessionId].map((m) =>
        el('div', { class: 'm ' + m.role }, [el('div', { class: 'r', text: m.role === 'user' ? 'you' : 'claude' }), el('div', { class: 't', text: m.text })]))));
    }
    b.appendChild(card);
  });

  d.appendChild(b);
  document.body.appendChild(scrim);
  document.body.appendChild(d);
  drawer._nodes = [scrim, d];
}
function closeDrawer() { (drawer._nodes || []).forEach((n) => n.remove()); drawer._nodes = []; S.drawer = null; }

/* ── actions ───────────────────────────────────────────────────────── */
function openTerm(s, opts) {
  if (!s) return toast('No session to open');
  if (!s.title) s = Object.assign({}, s, { title: s.sessionId.slice(0, 8) });
  if (!window.WBTerm) return toast('Terminal unavailable');
  setMode('work');
  window.WBTerm.open(s, opts || {});
  workRail();
  setTimeout(load, 1200);
}

async function launch(s, fork) {
  if (!s) return toast('No session to resume');
  try {
    const j = await api('/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: s.sessionId, cwd: s.cwd, fork }) });
    toast((j.created ? 'Started ' : 'Attached ') + j.tmuxSession);
    setTimeout(load, 800);
  } catch (e) { toast('Launch failed: ' + e.message); }
}

function bulkbar() {
  const bar = $('#bulk');
  if (!S.picked.size) { bar.hidden = true; return; }
  bar.hidden = false; bar.innerHTML = '';
  bar.appendChild(el('span', { text: `${S.picked.size} selected` }));
  bar.appendChild(el('button', { class: 'btn sm', text: 'Move to…', onclick: (e) => openMenu(e,
    S.inits.map((i) => el('button', { onclick: () => bulkPatch({ initiativeId: i.id }) }, [
      el('span', { class: 'swatch', style: `background: var(--c-${i.color})` }), i.name]))) }));
  bar.appendChild(el('button', { class: 'btn sm', text: 'Status…', onclick: (e) => openMenu(e,
    S.statuses.map((s) => el('button', { onclick: () => bulkPatch({ status: s }) }, [
      el('span', { class: 'swatch', style: `background: var(--st-${s})` }), STATUS_LABEL[s]]))) }));
  bar.appendChild(el('button', { class: 'btn sm', text: 'Wrap up…', onclick: (e) => openMenu(e,
    ['done', 'paused', 'blocked', 'dropped'].map((st) => el('button', {
      onclick: () => bulkPatch({ status: st }).then(() => load()),
    }, [el('span', { class: 'swatch', style: `background: var(--st-${st})` }), STATUS_LABEL[st]]))) }));
  bar.appendChild(el('button', { class: 'btn sm', text: 'Merge', disabled: S.picked.size < 2 ? 'disabled' : null,
    onclick: async () => {
      try { await api('/api/merge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [...S.picked] }) });
        S.picked.clear(); toast('Merged'); load(); } catch (e) { toast('Merge failed: ' + e.message); }
    } }));
  bar.appendChild(el('button', { class: 'btn sm', text: '✕', onclick: () => { S.picked.clear(); render(); } }));
}

// Start a fresh conversation: pick where it runs, name it, drop into the terminal.
async function newSessionMenu(ev) {
  const anchor = ev.currentTarget;      // must be read before the first await
  let dirs = [];
  try { dirs = (await api('/api/workdirs')).dirs || []; } catch {}
  const title = el('input', { placeholder: 'What is it? (optional)' });
  const custom = el('input', { placeholder: 'Or type a path…' });

  const start = async (cwd) => {
    closeMenu();
    toast('Starting…');
    try {
      const s = await api('/api/session/new', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd, title: title.value }),
      });
      openTerm({ sessionId: s.sessionId, cwd: s.cwd, title: s.title });
      toast('Started in ' + s.cwd.replace(/^.*\//, ''));
    } catch (e) { toast('Failed: ' + e.message); }
  };

  openMenu(anchor, [
    el('div', { style: 'font-size:11px;color:var(--ink-3);padding:4px 10px 6px;letter-spacing:.06em;text-transform:uppercase', text: 'Name' }),
    title,
    el('div', { style: 'font-size:11px;color:var(--ink-3);padding:8px 10px 6px;letter-spacing:.06em;text-transform:uppercase', text: 'Where' }),
    ...dirs.slice(0, 8).map((d) => el('button', { onclick: () => start(d.cwd) }, [
      el('span', { class: 'swatch', style: 'background: var(--brand)' }),
      el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis' }, [d.cwd.replace(/^\/Users\/[^/]+\//, '~/')]),
      el('span', { style: 'font:10.5px var(--mono);color:var(--ink-3)', text: String(d.sessions) }),
    ])),
    el('hr'),
    custom,
    el('button', { text: 'Start here ↵', onclick: () => custom.value.trim() && start(custom.value.trim()) }),
  ]);
  custom.addEventListener('keydown', (e) => { if (e.key === 'Enter' && custom.value.trim()) start(custom.value.trim()); });
  setTimeout(() => title.focus(), 20);
}

// Getting text out of a TUI that owns the mouse: read it from tmux instead.
async function copyMenu(ev) {
  const anchor = ev.currentTarget;
  const T = window.WBTerm;
  const tab = T && T.tabs.find((t) => t.id === T.active);
  if (!tab) return toast('No session open');

  const put = async (text, label) => {
    closeMenu();
    if (!text || !text.trim()) return toast('Nothing to copy');
    const ok = await T.copyText(text);
    toast(ok ? `Copied ${label} (${text.split('\n').length} lines)` : 'Copy blocked by the browser');
  };
  const grab = async (lines, label) => {
    try {
      const j = await api('/api/capture?sessionId=' + encodeURIComponent(tab.id) + '&lines=' + lines);
      await put(j.text, label);
    } catch (e) { closeMenu(); toast('Capture failed: ' + e.message); }
  };

  const sel = tab.term.hasSelection() ? tab.term.getSelection() : '';
  openMenu(anchor, [
    el('div', { style: 'font-size:11px;color:var(--ink-3);padding:4px 10px 6px;letter-spacing:.06em;text-transform:uppercase', text: 'Copy from terminal' }),
    el('button', { text: sel ? `Selection (${sel.split('\n').length} lines)` : 'Selection — none yet',
      onclick: () => sel ? put(sel, 'selection') : (closeMenu(), toast('Select with ⌥ drag first')) }),
    el('button', { text: 'Visible screen', onclick: () => grab(0, 'screen') }),
    el('button', { text: 'Last 1,000 lines', onclick: () => grab(1000, '1,000 lines') }),
    el('button', { text: 'Full scrollback', onclick: () => grab(50000, 'scrollback') }),
    el('hr'),
    el('div', { style: 'font-size:11.5px;color:var(--ink-3);padding:4px 10px 6px;line-height:1.45' },
      ['The Claude TUI captures the mouse, so a plain drag scrolls it instead of selecting. Hold ⌥ to select, then ⌘C.']),
  ]);
}

/* ── notifications ─────────────────────────────────────────────────── */
// The Stop hook posts every finished turn to the server, which pushes it here.
// A browser notification instead of osascript: it is owned by the browser, so
// clicking it lands on this page instead of launching Script Editor.
const NK = 'wb-notify';   // 'off' = muted here, even though the browser allows it
const canNotify = () => 'Notification' in window;
const notifyOn = () => canNotify() && Notification.permission === 'granted' && localStorage.getItem(NK) !== 'off';

function paintBell() {
  const b = $('#notify');
  const on = notifyOn();
  b.classList.toggle('off', !on);
  b.title = !canNotify() ? 'This browser has no notifications'
    : Notification.permission === 'denied' ? 'Notifications are blocked for this site — allow them in the browser’s site settings'
    : on ? 'Notifying when a turn finishes · click to mute' : 'Notify me when a turn finishes';
}

function onTurnDone(ev) {
  if (!notifyOn()) return;
  const T = window.WBTerm;
  // You are already looking at it.
  if (document.visibilityState === 'visible' && document.hasFocus() && S.mode === 'work' && T && T.active === ev.sessionId) return;
  const r = rowForSession(ev.sessionId);
  const n = new Notification(r ? r.title : 'Claude finished', {
    body: ev.message || 'Waiting for you', tag: ev.sessionId,
  });
  // Only jump to a terminal the workbench already has. Resuming a session that
  // is running in another terminal would start a second claude on it.
  n.onclick = () => {
    window.focus(); n.close();
    if (T && T.tabs.some((t) => t.id === ev.sessionId)) { setMode('work'); T.activate(ev.sessionId); workRail(); }
    else if (r) { S.drawer = r.id; drawer(r); }
  };
}

new EventSource('/api/events').onmessage = (m) => {
  let ev; try { ev = JSON.parse(m.data); } catch { return; }
  if (ev.type === 'turn-done') onTurnDone(ev);
};

$('#notify').addEventListener('click', async () => {
  if (!canNotify()) return toast('This browser has no notifications');
  if (Notification.permission === 'denied') return toast('Blocked — allow notifications in the site settings');
  if (Notification.permission === 'default') { await Notification.requestPermission(); localStorage.removeItem(NK); }
  else localStorage.setItem(NK, notifyOn() ? 'off' : 'on');
  paintBell();
  toast(notifyOn() ? 'Notifications on' : 'Notifications off');
});
paintBell();

/* ── ask claude ────────────────────────────────────────────────────── */
// Search by meaning. A headless claude run reads the board (and the transcripts
// behind it when it has to) and answers with ranked items and a reason for each.
// That session is never shown — this panel is its whole interface.
const ASK = { query: '', matches: null, error: null, meta: null, steps: [], t0: 0, ctl: null, tick: null, sel: 0, ui: null };
const ASK_EXAMPLES = ['the session where a deploy failed', 'open work waiting on someone else', 'anything about lemlist last month'];

const askRow = (id) => S.rows.find((r) => r.id === id) || (id.startsWith('v:') ? rowForSession(id.slice(2)) : null);

function askOpen(query) {
  if (!ASK.ui) askMount();
  const q = String(query || '').trim() || ASK.query;
  ASK.ui.input.value = q;
  if (q && (q !== ASK.query || ASK.error)) askRun(q); else askPaint();
  setTimeout(() => { if (ASK.ui) { ASK.ui.input.focus(); ASK.ui.input.select(); } }, 0);
}

function askClose() {
  // Closing mid-run kills the search; forget the query so reopening re-runs it.
  if (ASK.ctl) { ASK.ctl.abort(); ASK.ctl = null; ASK.query = ''; }
  clearInterval(ASK.tick);
  if (ASK.ui) { ASK.ui.root.remove(); ASK.ui = null; }
}

function askMount() {
  const input = el('input', { class: 'ask-q', type: 'text', placeholder: 'Describe the work you’re looking for…',
    autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Ask Claude to find work' });
  input.addEventListener('keydown', askKey);
  const status = el('div', { class: 'ask-status', 'aria-live': 'polite' });
  const body = el('div', { class: 'ask-body', role: 'listbox' });
  const foot = el('div', { class: 'ask-foot' });
  const box = el('div', { class: 'ask-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ask Claude' }, [
    el('div', { class: 'ask-head' }, [
      el('span', { class: 'ask-glyph', text: '✦', 'aria-hidden': 'true' }), input,
      el('button', { class: 'ask-x', text: 'esc', title: 'Close', onclick: askClose }),
    ]),
    el('div', { class: 'ask-bar' }), status, body, foot,
  ]);
  const root = el('div', { class: 'ask' }, [box]);
  root.addEventListener('mousedown', (e) => { if (e.target === root) askClose(); });
  document.body.appendChild(root);
  ASK.ui = { root, input, status, body, foot };
}

function askKey(e) {
  const n = (ASK.matches || []).length;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); askClose(); return; }
  if (e.key === 'ArrowDown' && n) { e.preventDefault(); ASK.sel = (ASK.sel + 1) % n; askMark(); return; }
  if (e.key === 'ArrowUp' && n) { e.preventDefault(); ASK.sel = (ASK.sel - 1 + n) % n; askMark(); return; }
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  const q = ASK.ui.input.value.trim();
  if (!q) return;
  if (q !== ASK.query || ASK.error) askRun(q);
  else if (n) askPick(ASK.matches[ASK.sel], e.altKey);
}

async function askRun(q) {
  if (ASK.ctl) ASK.ctl.abort();
  const ctl = new AbortController();
  Object.assign(ASK, { ctl, query: q, matches: null, error: null, meta: null, steps: [], t0: Date.now(), sel: 0 });
  clearInterval(ASK.tick);
  ASK.tick = setInterval(() => {
    const t = ASK.ui && ASK.ui.root.querySelector('.ask-time');
    if (t) t.textContent = Math.floor((Date.now() - ASK.t0) / 1000) + 's';
  }, 500);
  askPaint();
  try {
    const res = await fetch('/api/search/ai', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: q }), signal: ctl.signal,
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || res.statusText); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ASK.ctl !== ctl) return;
        if (ev.type === 'progress') ASK.steps.push(ev.text);
        else if (ev.type === 'error') ASK.error = ev.error;
        else if (ev.type === 'result') {
          ASK.matches = (ev.matches || []).filter((m) => askRow(m.id));
          ASK.meta = { ms: Date.now() - ASK.t0, cost: ev.costUsd || 0 };
        }
        askPaint();
      }
    }
    if (ASK.ctl === ctl && !ASK.matches && !ASK.error) ASK.error = 'The search ended without an answer.';
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (ASK.ctl === ctl) ASK.error = e.message;
  } finally {
    if (ASK.ctl === ctl) { ASK.ctl = null; clearInterval(ASK.tick); askPaint(); }
  }
}

function askPaint() {
  const u = ASK.ui;
  if (!u) return;
  const running = !!ASK.ctl;
  u.root.dataset.state = running ? 'running' : ASK.error ? 'error' : ASK.matches ? 'done' : 'idle';
  u.status.innerHTML = ''; u.body.innerHTML = ''; u.foot.innerHTML = '';

  if (running) {
    const now = ASK.steps[ASK.steps.length - 1] || 'Starting Claude';
    u.status.append(el('span', { class: 'ask-now', text: now + '…' }),
      el('span', { class: 'ask-time', text: Math.floor((Date.now() - ASK.t0) / 1000) + 's' }));
    u.body.appendChild(el('ol', { class: 'ask-trail' }, ASK.steps.slice(0, -1).map((s) => el('li', { text: s }))));
    u.foot.append(el('span', { text: 'Searching quietly in the background' }), el('span', { class: 'grow' }), el('span', { text: 'esc cancel' }));
    return;
  }
  if (ASK.error) {
    u.status.append(el('span', { class: 'ask-err', text: ASK.error }));
    u.foot.append(el('span', { class: 'grow' }), el('span', { text: '↵ try again · esc close' }));
    return;
  }
  if (ASK.matches) {
    if (!ASK.matches.length) {
      u.body.appendChild(el('div', { class: 'ask-empty' }, [
        el('strong', { text: 'Nothing matched.' }),
        el('div', { text: 'Try it another way — a topic, an error message, a file, roughly when.' })]));
    }
    ASK.matches.forEach((m, i) => { const r = askRow(m.id); if (r) u.body.appendChild(askItem(r, m, i)); });
    const n = ASK.matches.length;
    u.foot.append(
      el('span', { text: `${n} match${n === 1 ? '' : 'es'} · ${(ASK.meta.ms / 1000).toFixed(1)}s` + (ASK.meta.cost ? ` · $${ASK.meta.cost.toFixed(2)}` : '') }),
      el('span', { class: 'grow' }),
      el('span', { text: n ? '↑↓ choose · ↵ open · ⌥↵ details' : 'esc close' }));
    return;
  }
  u.body.appendChild(el('div', { class: 'ask-empty' }, [
    el('div', { text: 'Describe it the way you remember it. Claude reads the whole board, and the transcripts behind it when it has to.' }),
    el('div', { class: 'ask-ex' }, ASK_EXAMPLES.map((x) => el('button', { text: x, onclick: () => { u.input.value = x; askRun(x); } }))),
  ]));
  u.foot.append(el('span', { class: 'grow' }), el('span', { text: '↵ search · esc close' }));
}

function askItem(r, m, i) {
  return el('button', {
    class: 'ask-item', role: 'option', 'aria-selected': String(i === ASK.sel),
    onmousemove: () => { if (ASK.sel !== i) { ASK.sel = i; askMark(); } },
    onclick: (e) => askPick(m, e.altKey),
  }, [
    el('span', { class: 'dot', style: `--dot: ${r.initiativeId ? colorOf(r.initiativeId) : 'var(--c-none)'}` }),
    el('span', { class: 'ask-main' }, [
      el('span', { class: 'ask-title' }, [
        isLive(r) ? el('span', { class: 'livedot', title: 'claude is running in this session' }) : null,
        el('span', { text: r.title })]),
      el('span', { class: 'ask-why', text: m.why }),
    ]),
    el('span', { class: 'ask-meta' }, [
      el('span', { class: 'ask-st', style: `--st: var(--st-${r.status})`, text: STATUS_LABEL[r.status] }),
      el('span', { class: 'ask-sub', text: [r.project, ago(r.lastActivity)].filter(Boolean).join(' · ') }),
    ]),
  ]);
}

// Selection moves in place: rebuilding the list under the pointer would fight hover.
function askMark() {
  if (!ASK.ui) return;
  ASK.ui.body.querySelectorAll('.ask-item').forEach((n, i) => {
    n.setAttribute('aria-selected', String(i === ASK.sel));
    if (i === ASK.sel) n.scrollIntoView({ block: 'nearest' });
  });
}

function askPick(m, details) {
  const r = askRow(m.id);
  if (!r) return toast('That item is gone');
  askClose();
  if (details) { S.drawer = r.id; drawer(r); return; }
  openTerm(sessionOf(r));
}

/* ── wiring ────────────────────────────────────────────────────────── */
$('#workCopy').addEventListener('click', copyMenu);
$('#newSession').addEventListener('click', newSessionMenu);
$('#newSessionRail').addEventListener('click', newSessionMenu);
$('#q').addEventListener('input', (e) => { S.q = e.target.value; board(); });
$('#density').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.openMode = b.dataset.open;
  [...e.currentTarget.children].forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
  render();
});
$('#fStatus').addEventListener('click', (e) => openMenu(e, [
  ...S.statuses.map((s) => el('button', { onclick: () => { S.statusFilter.has(s) ? S.statusFilter.delete(s) : S.statusFilter.add(s); closeMenu(); render(); } }, [
    el('span', { class: 'swatch', style: `background: var(--st-${s}); opacity:${S.statusFilter.size && !S.statusFilter.has(s) ? 0.25 : 1}` }),
    STATUS_LABEL[s], S.statusFilter.has(s) ? ' ✓' : ''])),
  el('hr'), el('button', { text: 'Clear', onclick: () => { S.statusFilter.clear(); closeMenu(); render(); } })]));
$('#fOwner').addEventListener('click', (e) => {
  const people = [...new Set(base().map((r) => r.assignee).filter(Boolean))].sort();
  openMenu(e, [el('button', { text: 'Anyone', onclick: () => { S.owner = ''; closeMenu(); render(); } }),
    ...people.map((p) => el('button', { text: p, onclick: () => { S.owner = p; closeMenu(); render(); } }))]);
});
$('#fSort').addEventListener('click', (e) => openMenu(e,
  [['recent', 'Recent activity'], ['oldest', 'Oldest first'], ['name', 'Name A–Z'], ['effort', 'Most work']].map(([k, l]) =>
    el('button', { text: l + (S.sort === k ? ' ✓' : ''), onclick: () => { S.sort = k; closeMenu(); board(); } }))));
$('#addInit').addEventListener('click', (e) => {
  const input = el('input', { placeholder: 'Initiative name, then Enter',
    onkeydown: (ev) => {
      if (ev.key !== 'Enter') return;
      const name = ev.target.value.trim(); if (!name) return;
      api('/api/initiatives', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'save', initiative: { name, color: COLORS[S.inits.length % COLORS.length] } }) })
        .then(() => { closeMenu(); toast('Created'); load(); });
    } });
  openMenu(e, [input]);
});
$('#modeSwap').addEventListener('click', () => setMode(S.mode === 'work' ? 'board' : 'work'));
$('#workBoard').addEventListener('click', () => setMode('board'));
// Click the title = adopt the session's current name (/rename, --name, ai-title).
// Reindex first so a title record written moments ago is visible, then drop the
// item's override so the session's own title flows through — and keeps flowing
// on future renames.
$('#workTitle').addEventListener('click', async () => {
  const T = window.WBTerm;
  const a = T && T.tabs.find((t) => t.id === T.active);
  if (!a) return;
  const r = rowForSession(a.id);
  if (!r) { toast('No item for this session'); return; }
  const was = $('#workTitle').textContent;
  $('#workTitle').textContent = 'Syncing…';
  try {
    await adoptSessionTitle(r);
  } catch (err) {
    $('#workTitle').textContent = was;
    toast('Failed: ' + err.message);
  }
});
$('#workQ').addEventListener('input', (e) => { S.workQ = e.target.value; workRail(); });
$('#workQ').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.target.value.trim()) { e.preventDefault(); askOpen(e.target.value); }
});
$('#askBtn').addEventListener('click', () => askOpen($('#workQ').value));

$('#reindex').addEventListener('click', async (e) => {
  e.target.textContent = '…';
  try { const r = await api('/api/reindex', { method: 'POST' }); toast(`Indexed ${r.total}`); await load(); }
  catch (err) { toast('Failed: ' + err.message); }
  e.target.textContent = 'Re-index';
});
const TK = 'wb-theme';
// Two surfaces, one button. The page and the terminal don't have to agree: code and
// TUI chrome read better on a dark pane even when the rest of the app is light, so
// that combination earns its own stop in the cycle. Stored keys 'dark' and 'light'
// are the same ones the two-state version wrote, so nothing needs migrating.
const THEMES = [
  { k: 'system', theme: '',      term: '',     glyph: '\u25D0', label: 'follow system' },
  { k: 'dark',   theme: 'dark',  term: '',     glyph: '\u25CF', label: 'dark' },
  { k: 'light',  theme: 'light', term: '',     glyph: '\u25CB', label: 'light' },
  { k: 'split',  theme: 'light', term: 'dark', glyph: '\u25D1', label: 'light app, dark terminal' },
];
function applyTheme(key) {
  const t = THEMES.find((x) => x.k === key) || THEMES[0];
  const d = document.documentElement.dataset;
  if (t.theme) d.theme = t.theme; else delete d.theme;
  if (t.term) d.term = t.term; else delete d.term;
  if (t.k === 'system') localStorage.removeItem(TK); else localStorage.setItem(TK, t.k);
  // The glyph has to name the state it is in, not just the fact that a cycle exists —
  // four stops are indistinguishable otherwise.
  const btn = $('#theme');
  btn.textContent = t.glyph;
  btn.title = 'Theme: ' + t.label + ' \u00b7 click to change';
  if (window.WBTerm) window.WBTerm.retheme();
}
applyTheme(localStorage.getItem(TK) || 'system');
$('#theme').addEventListener('click', () => {
  const at = THEMES.findIndex((x) => x.k === (localStorage.getItem(TK) || 'system'));
  applyTheme(THEMES[(at + 1) % THEMES.length].k);
});
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName;
  if (e.target.closest && e.target.closest('.tdock')) return;  // terminal owns its keys
  if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'Escape') { closeMenu(); closeDrawer(); S.picked.clear(); render(); }
});
// Works even while the terminal has focus — xterm never sees Alt+Tab.
window.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'Tab' || e.code === 'Tab')) {
    e.preventDefault(); e.stopPropagation();
    setMode(S.mode === 'work' ? 'board' : 'work');
  }
}, true);

if (window.WBTerm) window.WBTerm.onchange = () => { if (S.mode === 'work') workRail(); };
document.body.dataset.mode = 'board';
setMode('work');

load().catch((e) => { $('#board').innerHTML = '<div class="empty"><strong>Could not load</strong>' + e.message + '</div>'; });
setInterval(() => { if (!S.drawer && !S.picked.size && !menuEl) load().catch(() => {}); }, 30000);
setInterval(paintAgentDots, 1200);
