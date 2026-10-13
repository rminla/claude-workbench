'use strict';
// Local-only workbench server. Executes shell commands (tmux/osascript),
// so it binds to loopback and never accepts a remote origin.

const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const store = require('./lib/store');
const view = require('./lib/view');
const indexer = require('./lib/indexer');
const launcher = require('./lib/launch');
const terminal = require('./lib/terminal');
const initiatives = require('./lib/initiatives');
const drops = require('./lib/drops');
const search = require('./lib/search');

let WebSocketServer = null;
try { WebSocketServer = require('ws').WebSocketServer; }
catch { console.warn('[workbench] `ws` not installed — embedded terminal disabled (npm install ws)'); }

const PORT = Number(process.env.WORKBENCH_PORT || 7788);
// Any *.localhost name is reserved by RFC 6761 and resolves to loopback with no
// /etc/hosts entry. Avoid .local — macOS routes it to mDNS, so resolution stalls
// for seconds and then fails regardless of what /etc/hosts says.
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[?::1\]?|[a-z0-9-]+\.localhost)$/i;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?$/i;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Materialise a virtual row (id "v:<sessionId>") into a real overlay item.
function resolveItem(db, id) {
  if (typeof id === 'string' && id.startsWith('v:')) {
    return store.ensureItem(db, id.slice(2));
  }
  return db.items[id] || null;
}

const EDITABLE = new Set(['title', 'status', 'bucket', 'assignee', 'note', 'jiraKey', 'tags', 'initiativeId']);

async function tail(file, n) {
  const lines = [];
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isMeta) continue;
    const c = o.message && o.message.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
    if (!text.trim()) continue;
    lines.push({ role: o.type, at: o.timestamp || null, text: text.trim().slice(0, 1200) });
    if (lines.length > n * 4) lines.splice(0, lines.length - n * 4);
  }
  rl.close(); stream.destroy();
  return lines.slice(-n);
}

// The page stays open for days (tabs auto-reconnect), so an edited app.js/css
// silently never reaches it. Stamp the frontend files; the client reloads
// itself when the stamp moves.
function assetStamp() {
  let m = 0;
  for (const f of ['app.js', 'app.css', 'index.html', 'term.js']) {
    try { m = Math.max(m, fs.statSync(path.join(PUBLIC, f)).mtimeMs); } catch {}
  }
  return Math.round(m);
}

// Open pages listen here for pushes (turn-finished notifications). EventSource
// reconnects on its own, so a page that slept just picks up the next one.
const listeners = new Set();
function broadcast(ev) {
  const frame = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const res of listeners) res.write(frame);
}
setInterval(() => { for (const res of listeners) res.write(': ping\n\n'); }, 25000).unref();

// Notice a claude exiting inside its tmux even when no page is polling, so a
// session closed that way is not brought back by the next reboot.
setInterval(() => { try { launcher.restorable(); } catch {} }, 60000).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // Reject cross-origin form posts / DNS-rebinding attempts. Only loopback names.
  const host = (req.headers.host || '').split(':')[0];
  if (!LOCAL_HOST_RE.test(host)) return json(res, 403, { error: 'forbidden host' });
  if (req.method === 'POST') {
    const o = req.headers.origin;
    if (o && !LOCAL_ORIGIN.test(o)) return json(res, 403, { error: 'bad origin' });
  }

  try {
    if (p === '/api/rows' && req.method === 'GET') {
      const v = view.build();
      return json(res, 200, Object.assign(v, { live: launcher.listLive(), idle: launcher.listIdle(), restore: launcher.restorable(), statuses: store.STATUSES, buckets: store.BUCKETS, assetStamp: assetStamp() }));
    }

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hello\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }

    // From the Stop hook: a turn finished somewhere. The page decides whether
    // to show it (it stays quiet when you are already looking at that session).
    if (p === '/api/notify' && req.method === 'POST') {
      const { sessionId, message } = await readBody(req);
      if (typeof sessionId !== 'string' || !sessionId) return json(res, 400, { error: 'no session id' });
      broadcast({ type: 'turn-done', sessionId, message: typeof message === 'string' ? message.slice(0, 300) : '' });
      return json(res, 200, { ok: true, listeners: listeners.size });
    }

    // Ask Claude to find work. Streams NDJSON progress lines, then one result
    // (or error) line. The client aborting the fetch kills the run.
    if (p === '/api/search/ai' && req.method === 'POST') {
      const { query } = await readBody(req);
      const q = typeof query === 'string' ? query.trim() : '';
      if (!q) return json(res, 400, { error: 'empty query' });
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      const send = (ev) => {
        if (res.writableEnded) return;
        res.write(JSON.stringify(ev) + '\n');
        if (ev.type === 'result' || ev.type === 'error') res.end();
      };
      // Headers are already out, so a failure here has to travel as a line.
      try {
        const job = search.run(q, send);
        res.on('close', () => { if (!res.writableFinished) job.cancel(); });
      } catch (e) { send({ type: 'error', error: String((e && e.message) || e) }); }
      return;
    }

    if (p === '/api/item' && req.method === 'POST') {
      const { id, patch } = await readBody(req);
      const db = store.load();
      const it = resolveItem(db, id);
      if (!it) return json(res, 404, { error: 'no such item' });
      for (const k of Object.keys(patch || {})) {
        if (!EDITABLE.has(k)) continue;
        if (k === 'status' && !store.STATUSES.includes(patch[k])) continue;
        if (k === 'bucket' && !store.BUCKETS.includes(patch[k])) continue;
        if (k === 'tags') { it.tags = (patch.tags || []).map(String).filter(Boolean).slice(0, 12); continue; }
        it[k] = patch[k] === '' ? (k === 'note' ? '' : null) : patch[k];
        if (k === 'status') { it.needsWrapUp = false; it.wrappedAt = new Date().toISOString(); }
      }
      it.updatedAt = new Date().toISOString();
      store.save(db);
      return json(res, 200, { ok: true, id: it.id });
    }

    if (p === '/api/initiatives' && req.method === 'POST') {
      const { action, initiative, id, order } = await readBody(req);
      const db = initiatives.load();
      if (action === 'save' && initiative && initiative.name) {
        const existing = db.initiatives.find((x) => x.id === initiative.id);
        if (existing) Object.assign(existing, { name: initiative.name, color: initiative.color, hint: initiative.hint, archived: !!initiative.archived });
        else db.initiatives.push({ id: initiative.id || ('i' + Date.now().toString(36)), name: initiative.name, color: initiative.color || 'slate', hint: initiative.hint || '', rules: [], archived: false, order: db.initiatives.length });
      } else if (action === 'archive' && id) {
        const x = db.initiatives.find((i) => i.id === id); if (x) x.archived = true;
      } else if (action === 'reorder' && Array.isArray(order)) {
        order.forEach((iid, i) => { const x = db.initiatives.find((n) => n.id === iid); if (x) x.order = i; });
      } else return json(res, 400, { error: 'bad action' });
      initiatives.save(db);
      return json(res, 200, { ok: true, initiatives: db.initiatives });
    }

    if (p === '/api/bulk' && req.method === 'POST') {
      const { ids, patch } = await readBody(req);
      if (!Array.isArray(ids) || !ids.length) return json(res, 400, { error: 'no ids' });
      const db = store.load();
      let n = 0;
      for (const rid of ids) {
        const it = resolveItem(db, rid);
        if (!it) continue;
        for (const k of Object.keys(patch || {})) {
          if (!EDITABLE.has(k)) continue;
          if (k === 'status' && !store.STATUSES.includes(patch[k])) continue;
          if (k === 'bucket' && !store.BUCKETS.includes(patch[k])) continue;
          it[k] = patch[k];
          // Stating a status answers the wrap-up question.
          if (k === 'status') { it.needsWrapUp = false; it.wrappedAt = new Date().toISOString(); }
        }
        it.updatedAt = new Date().toISOString();
        n++;
      }
      store.save(db);
      return json(res, 200, { ok: true, updated: n });
    }

    // Closing out a piece of work: a person states where it stands, and
    // optionally ends the tmux session behind it.
    if (p === '/api/wrapup' && req.method === 'POST') {
      const { id, status, note, end } = await readBody(req);
      if (!store.STATUSES.includes(status)) return json(res, 400, { error: 'bad status' });
      const db = store.load();
      const it = resolveItem(db, id);
      if (!it) return json(res, 404, { error: 'no such item' });

      it.status = status;
      if (typeof note === 'string' && note.trim()) {
        it.note = it.note ? (it.note.trim() + '\n' + note.trim()) : note.trim();
      }
      it.needsWrapUp = false;
      it.wrappedAt = new Date().toISOString();
      it.updatedAt = it.wrappedAt;
      store.save(db);

      const ended = [];
      if (end) {
        for (const sid of it.sessionIds || []) {
          try { ended.push(launcher.end(sid)); } catch {}
        }
      }
      return json(res, 200, { ok: true, id: it.id, status, ended });
    }

    if (p === '/api/merge' && req.method === 'POST') {
      const { ids } = await readBody(req);
      if (!Array.isArray(ids) || ids.length < 2) return json(res, 400, { error: 'need 2+ ids' });
      const db = store.load();
      const real = ids.map((id) => resolveItem(db, id)).filter(Boolean);
      if (real.length < 2) return json(res, 400, { error: 'could not resolve' });
      const target = real[0];
      store.mergeItems(db, target.id, real.slice(1).map((x) => x.id));
      store.save(db);
      return json(res, 200, { ok: true, id: target.id });
    }

    // Start a brand-new conversation. The id is pre-assigned so the tmux session,
    // the terminal tab and the eventual transcript all agree from the first keystroke.
    if (p === '/api/session/new' && req.method === 'POST') {
      const { cwd, title } = await readBody(req);
      const out = launcher.create({ cwd, title });
      // Give the session an overlay row NOW. The transcript does not exist yet,
      // so without this the name the person just typed has nowhere to live and
      // the board would not show the session until its first turn ends.
      const db = store.load();
      const it = store.ensureItem(db, out.sessionId, {
        status: 'active', bucket: 'now', cwd: out.cwd,
        title: (title && String(title).trim()) || null,
      });
      store.save(db);
      return json(res, 200, Object.assign({ ok: true, itemId: it.id }, out));
    }

    // Directories worth offering when starting something new.
    if (p === '/api/workdirs' && req.method === 'GET') {
      const idx = indexer.loadIndex();
      const counts = Object.create(null);
      for (const s of Object.values(idx.sessions)) {
        if (!s || !s.cwd || !(s.userMsgs > 0)) continue;
        if (s.entrypoint === 'sdk-cli') continue;
        counts[s.cwd] = (counts[s.cwd] || 0) + 1;
      }
      const dirs = Object.keys(counts)
        .filter((d) => fs.existsSync(d))
        .sort((a, b) => counts[b] - counts[a])
        .map((d) => ({ cwd: d, sessions: counts[d] }));
      return json(res, 200, { dirs });
    }

    // Drag & drop onto the terminal. The browser never exposes a dropped file's
    // real path, so resolve it from Spotlight by name and verify with size+mtime
    // before trusting the answer.
    if (p === '/api/drop/resolve' && req.method === 'POST') {
      const { name, size, mtime } = await readBody(req);
      return json(res, 200, { path: drops.resolve({ name, size, mtime }) });
    }

    // Nothing on disk matched (a drag out of another browser, an unindexed
    // volume). Keep the bytes so the path we paste points at something real.
    if (p === '/api/drop/save' && req.method === 'POST') {
      const name = req.headers['x-drop-name'];
      try {
        const saved = await drops.save(name, req);
        return json(res, 200, { path: saved, saved: true });
      } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }

    if (p === '/api/capture' && req.method === 'GET') {
      const sid = url.searchParams.get('sessionId');
      const lines = url.searchParams.get('lines');
      try {
        const text = launcher.capture(sid, lines);
        return json(res, 200, { ok: true, text, lines: text ? text.split('\n').length : 0 });
      } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }

    // The dock's ✕ ends the work rather than just hiding it: a session can always
    // be resumed, so leaving orphaned tmux containers around costs more than it saves.
    if (p === '/api/session/status' && req.method === 'GET') {
      try {
        return json(res, 200, Object.assign({ ok: true }, launcher.status(url.searchParams.get('sessionId'))));
      } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }

    if (p === '/api/session/end' && req.method === 'POST') {
      const { sessionId } = await readBody(req);
      try {
        return json(res, 200, Object.assign({ ok: true }, launcher.end(sessionId)));
      } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }

    if (p === '/api/prune' && req.method === 'POST') {
      const killed = launcher.pruneIdle();
      return json(res, 200, { ok: true, killed });
    }

    if (p === '/api/launch' && req.method === 'POST') {
      const { sessionId, cwd, fork } = await readBody(req);
      const out = launcher.launch({ sessionId, cwd, fork: !!fork });
      return json(res, 200, Object.assign({ ok: true }, out));
    }

    if (p === '/api/reindex' && req.method === 'POST') {
      const r = await indexer.reindex();
      return json(res, 200, Object.assign({ ok: true }, r));
    }

    if (p === '/api/transcript' && req.method === 'GET') {
      const sid = url.searchParams.get('sessionId') || '';
      const idx = indexer.loadIndex();
      const s = idx.sessions[sid];
      if (!s || !s.file || !fs.existsSync(s.file)) return json(res, 404, { error: 'not found' });
      return json(res, 200, { sessionId: sid, messages: await tail(s.file, 12) });
    }

    // static
    let rel = p === '/' ? '/index.html' : p;
    const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  } catch (err) {
    return json(res, 500, { error: String((err && err.message) || err) });
  }
});

if (WebSocketServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
    const host = (req.headers.host || '').split(':')[0];
    const origin = req.headers.origin;
    const localHost = LOCAL_HOST_RE.test(host);
    const localOrigin = !origin || LOCAL_ORIGIN.test(origin);
    // This hands out a shell. Refuse anything that is not same-origin loopback.
    if (url.pathname !== '/ws/term' || !localHost || !localOrigin) return socket.destroy();

    wss.handleUpgrade(req, socket, head, (ws) => {
      terminal.attach(ws, {
        sessionId: url.searchParams.get('sessionId'),
        cwd: url.searchParams.get('cwd'),
        fork: url.searchParams.get('fork') === '1',
        cols: url.searchParams.get('cols'),
        rows: url.searchParams.get('rows'),
      });
    });
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`workbench -> http://localhost:${PORT}` + (WebSocketServer ? '  (terminal enabled)' : ''));
});
