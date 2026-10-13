'use strict';
// Builds the DERIVED session index from Claude Code transcripts.
// Read-only with respect to ~/.claude/projects. Incremental: a transcript is
// re-parsed only when its mtime or size changed since the last run.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { PROJECTS_DIR, INDEX_FILE, DEV_ROOT } = require('./paths');

const REPO_RE = new RegExp(DEV_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/([A-Za-z0-9_.-]+)', 'g');

function listTranscripts() {
  const out = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({ file: full, bucket: d.name, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

// Skip synthetic prompts injected by hooks/harness rather than typed by the user.
function isRealPrompt(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 2) return false;
  if (t.startsWith('<')) return false;
  if (t.startsWith('Caveat:')) return false;
  if (t.startsWith('[Request interrupted')) return false;
  if (/^ARGUMENTS=/.test(t)) return false;
  return true;
}

async function parseTranscript(entry) {
  const rec = {
    sessionId: path.basename(entry.file, '.jsonl'),
    file: entry.file,
    bucket: entry.bucket,
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    aiTitle: null,
    customTitle: null,
    cwd: null,
    branch: null,
    firstPrompt: null,
    lastPrompt: null,
    started: null,
    lastActivity: null,
    userMsgs: 0,
    assistantMsgs: 0,
    repo: null,
    endedWith: null,
    entrypoint: null,
    promptSource: null,
  };

  const repoHits = Object.create(null);
  const stream = fs.createReadStream(entry.file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;

      // Cheap repo inference straight off the raw line — no JSON parse needed.
      if (line.includes(DEV_ROOT)) {
        REPO_RE.lastIndex = 0;
        let m;
        while ((m = REPO_RE.exec(line))) repoHits[m[1]] = (repoHits[m[1]] || 0) + 1;
      }

      // Guard every parse behind a substring test; most lines are tool spam.
      // `--name` and /rename write a custom-title record; it is the human's
      // own name for the session and outranks the generated ai-title.
      const isTitle = line.includes('"ai-title"') || line.includes('"custom-title"');
      const isUser = line.includes('"type":"user"');
      const isAsst = line.includes('"type":"assistant"');
      if (!isTitle && !isUser && !isAsst) continue;

      let o;
      try { o = JSON.parse(line); } catch { continue; }

      if (o.type === 'ai-title') {
        if (o.aiTitle) rec.aiTitle = o.aiTitle;
        continue;
      }
      if (o.type === 'custom-title') {
        // Last one wins: renaming twice must land on the second name.
        rec.customTitle = o.customTitle || null;
        continue;
      }
      if (o.type !== 'user' && o.type !== 'assistant') continue;

      if (o.entrypoint) rec.entrypoint = o.entrypoint;
      if (o.promptSource) rec.promptSource = o.promptSource;
      if (o.cwd) rec.cwd = o.cwd;
      if (o.gitBranch) rec.branch = o.gitBranch;
      if (o.timestamp) {
        if (!rec.started) rec.started = o.timestamp;
        rec.lastActivity = o.timestamp;
      }

      if (o.type === 'assistant') {
        rec.assistantMsgs++;
        rec.endedWith = 'assistant';
        continue;
      }

      // user
      if (o.isMeta || o.isCompactSummary) continue;
      const txt = textOf(o.message && o.message.content);
      if (!isRealPrompt(txt)) continue;
      rec.userMsgs++;
      rec.endedWith = 'user';
      const clipped = txt.trim().slice(0, 400);
      if (!rec.firstPrompt) rec.firstPrompt = clipped;
      rec.lastPrompt = clipped;
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const ranked = Object.keys(repoHits).sort((a, b) => repoHits[b] - repoHits[a]);
  if (ranked.length) rec.repo = ranked[0];

  return rec;
}

const SCHEMA = 3; // bump when the derived record shape changes -> forces full re-parse

function loadIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (raw.version !== SCHEMA) return { version: SCHEMA, updatedAt: null, sessions: {} };
    return raw;
  } catch {
    return { version: SCHEMA, updatedAt: null, sessions: {} };
  }
}

function saveIndex(idx) {
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx));
  fs.renameSync(tmp, INDEX_FILE);
}

// Rebuilds the index over EVERY transcript found. No cap, no sampling —
// unchanged files are skipped via mtime/size, not dropped.
async function reindex({ onProgress } = {}) {
  const idx = loadIndex();
  idx.version = SCHEMA;
  const found = listTranscripts();
  const seen = new Set();
  let parsed = 0;
  let skipped = 0;

  for (let i = 0; i < found.length; i++) {
    const entry = found[i];
    const id = path.basename(entry.file, '.jsonl');
    seen.add(id);
    const prev = idx.sessions[id];
    if (prev && prev.mtimeMs === entry.mtimeMs && prev.size === entry.size) {
      skipped++;
    } else {
      try {
        idx.sessions[id] = await parseTranscript(entry);
        parsed++;
      } catch (err) {
        // Keep whatever we had rather than losing the row entirely.
        if (!prev) idx.sessions[id] = { sessionId: id, file: entry.file, error: String(err && err.message) };
      }
    }
    if (onProgress && i % 25 === 0) onProgress({ done: i + 1, total: found.length, parsed, skipped });
  }

  // Drop rows whose transcript no longer exists on disk.
  let removed = 0;
  for (const id of Object.keys(idx.sessions)) {
    if (!seen.has(id)) { delete idx.sessions[id]; removed++; }
  }

  idx.updatedAt = new Date().toISOString();
  saveIndex(idx);
  return { total: found.length, parsed, skipped, removed };
}

module.exports = { reindex, loadIndex, saveIndex, listTranscripts, parseTranscript };
