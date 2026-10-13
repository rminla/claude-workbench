#!/usr/bin/env node
'use strict';
// Stop hook: when a session ends, index that one transcript and make sure the
// work it represents has a workbench item. Never blocks or fails the session.

const fs = require('fs');
const path = require('path');

function bail(msg) { if (process.env.WORKBENCH_DEBUG) console.error('[workbench] ' + msg); process.exit(0); }

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { main(raw).catch((e) => bail(String(e && e.message))); });
setTimeout(() => bail('stdin timeout'), 4000).unref();

async function main(raw) {
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch {}

  const sessionId = payload.session_id || payload.sessionId;
  const transcript = payload.transcript_path || payload.transcriptPath;
  if (!sessionId) return bail('no session id');

  // Tell any open workbench page first — indexing below can take a moment on a
  // long transcript, and the notification is the part a person is waiting on.
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-cli') {
    await notify(sessionId, firstLine(payload.last_assistant_message));
  }

  const indexer = require('../lib/indexer');
  const store = require('../lib/store');

  // Index just this transcript so the workbench reflects the session immediately.
  let rec = null;
  if (transcript && fs.existsSync(transcript)) {
    const st = fs.statSync(transcript);
    rec = await indexer.parseTranscript({
      file: transcript,
      bucket: path.basename(path.dirname(transcript)),
      mtimeMs: st.mtimeMs,
      size: st.size,
    });
    const idx = indexer.loadIndex();
    idx.sessions[rec.sessionId] = rec;
    indexer.saveIndex(idx);
  }

  // Automated/headless runs are indexed but never enter the triage queue.
  if (rec && rec.entrypoint === 'sdk-cli') return bail('headless session, not tracked');
  if (rec && !(rec.userMsgs > 0)) return bail('no human prompts, not tracked');

  const db = store.load();
  const owners = store.sessionOwners(db);
  if (owners[sessionId]) {
    const it = db.items[owners[sessionId]];
    it.updatedAt = new Date().toISOString();
    store.save(db);
    return bail('item already exists: ' + it.id);
  }

  store.ensureItem(db, sessionId, { status: 'inbox', bucket: 'next' });
  store.save(db);
  bail('captured ' + sessionId);
}

function firstLine(msg) {
  if (typeof msg !== 'string') return '';
  const line = msg.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.slice(0, 200);
}

// Best effort: no server, or no page listening, just means no notification.
function notify(sessionId, message) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ sessionId, message });
    const req = require('http').request({
      host: '127.0.0.1', port: Number(process.env.WORKBENCH_PORT || 7788), path: '/api/notify', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 700,
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('timeout', () => req.destroy());
    req.on('error', resolve);
    req.end(body);
  });
}
