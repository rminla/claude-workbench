#!/usr/bin/env node
'use strict';
// SessionEnd hook: a session actually closed. Flag it as needing a status.
//
// It deliberately does NOT guess the status. Measured over 559 real sessions,
// 96% end on an assistant message and ~75% of final messages carry no signal
// about whether the work finished — so an inferred status would mostly be a
// confident lie, and the dangerous direction (false "done") hides live work.

const fs = require('fs');
const path = require('path');

function bail(msg) { if (process.env.WORKBENCH_DEBUG) console.error('[workbench] ' + msg); process.exit(0); }

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => { main(raw).catch((e) => bail(String(e && e.message))); });
setTimeout(() => bail('stdin timeout'), 4000).unref();

async function main(raw) {
  let p = {};
  try { p = raw ? JSON.parse(raw) : {}; } catch {}

  const sessionId = p.session_id || p.sessionId;
  const transcript = p.transcript_path || p.transcriptPath;
  const reason = p.reason || p.end_reason || 'other';
  if (!sessionId) return bail('no session id');

  const indexer = require('../lib/indexer');
  const store = require('../lib/store');

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

  if (rec && rec.entrypoint === 'sdk-cli') return bail('headless, not tracked');
  if (rec && !(rec.userMsgs > 0)) return bail('no human prompts, not tracked');

  // "clear" starts a fresh conversation in the same window — not a close.
  if (reason === 'clear') return bail('cleared, not ended');

  // A malformed payload must never mint a phantom item.
  if (!rec) {
    const known = indexer.loadIndex().sessions[sessionId];
    if (!known) return bail('unknown session, refusing to create item');
  }

  const db = store.load();
  const it = store.ensureItem(db, sessionId, { status: 'inbox', bucket: 'next' });
  it.endedAt = new Date().toISOString();
  it.endReason = reason;
  // Only ask if a person has not already said where this stands.
  if (!it.wrappedAt && (it.status === 'inbox' || it.status === 'active')) it.needsWrapUp = true;
  it.updatedAt = it.endedAt;
  store.save(db);
  bail(`flagged ${it.id} (${reason}) needsWrapUp=${it.needsWrapUp}`);
}
