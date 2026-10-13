'use strict';
// "Ask Claude" search. A headless claude run gets the board's catalog in its
// prompt, can grep a fuller catalog file and the raw transcripts when the
// question is about something said inside a session, and answers with ranked
// row ids plus a one-line reason.
//
// --safe-mode: no hooks, MCP, plugins or CLAUDE.md — faster, and the user's
//   Stop hooks (notifications, the workbench's own capture) never fire for it.
// --no-session-persistence: the search never becomes a transcript, so it can
//   never show up on the board or in a later search.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { HOME, WB_DIR, PROJECTS_DIR } = require('./paths');
const view = require('./view');

const WORK_DIR = path.join(WB_DIR, 'data', 'search');
const CATALOG = path.join(WORK_DIR, 'catalog.txt');
const MODEL = 'sonnet';
const EFFORT = 'medium';
const TOOLS = 'Read,Grep,Glob';

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'item id or session id from the catalog' },
          why: { type: 'string', description: 'one short line: what in this item matches the query' },
        },
        required: ['id', 'why'],
      },
    },
  },
  required: ['matches'],
});

function claudeBin() {
  for (const p of [path.join(HOME, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  return 'claude';
}

const day = (iso) => (iso ? iso.slice(0, 10) : '');
const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : '');

// Two views of the same rows: a terse line per item that goes straight into the
// prompt (so Claude sees the whole board at once), and a fuller file it can grep.
// The file is one short fact per line, each prefixed with its row id, so any grep
// hit names its row — long JSON lines get truncated in grep output and Claude
// burns turns re-grepping just to see which row matched.
function writeCatalog(rows, initNames) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const lines = [];
  for (const r of rows) {
    const add = (k, v) => { if (v) lines.push(`${r.id} ${k}: ${v}`); };
    add('title', clip(r.title, 200));
    add('where', [r.status, initNames[r.initiativeId], r.project, r.branch, day(r.lastActivity)].filter(Boolean).join(' · '));
    add('note', clip(r.note, 500));
    add('tags', (r.tags || []).join(', '));
    add('jira', r.jiraKey);
    for (const s of r.sessions) {
      add('session', s.sessionId + (s.title && s.title !== r.title ? ' — ' + clip(s.title, 160) : ''));
      add('first-prompt', clip(s.firstPrompt, 500));
      add('last-prompt', clip(s.lastPrompt, 400));
    }
  }
  fs.writeFileSync(CATALOG, lines.join('\n') + '\n');
  return rows.map((r) => [r.id, r.status, initNames[r.initiativeId] || '-', r.project || '-',
    day(r.lastActivity), clip(r.title, 140)].join(' | ')).join('\n');
}

function prompt(query, terse, today) {
  return `You are the search engine for a personal work board. Every row is a piece of work backed by one or more Claude Code sessions. Today is ${today}.

Find the rows that match this query:

<query>${query}</query>

THE BOARD (one row per line: id | status | initiative | project | last active | title):
${terse}

Titles are auto-generated and often vague: a session about X frequently never says X in its title or prompts. Judge rows by evidence, not by title alone.

WHERE TO LOOK, cheapest first — stop once more searching would not change the answer:
1. The board above.
2. ${CATALOG} — more about every row: notes, tags, Jira keys, each session's id, first and last prompt. One fact per line, each line starts with its row id. Grep it case-insensitively (output_mode "content"); try synonyms and related terms in one alternation.
3. Memory notes: ${PROJECTS_DIR}/*/memory/**/*.md — short curated write-ups of past work, decisions and gotchas. High signal and cheap: grep them (content mode is fine, they are small). A note's frontmatter "originSessionId" is the session that produced it — return that session id.
4. Raw transcripts under ${PROJECTS_DIR}/<project-dir>/<sessionId>.jsonl. Use them whenever the query names something specific (a product, tool, error, file, person, decision) — that is where vague-titled sessions get found.
   Transcript lines are huge JSON, so grep output can never show you useful context — don't try (no ".{0,200}" context patterns, no content mode, no reading transcripts). The recipe is: ONE Grep over ${PROJECTS_DIR} with output_mode "files_with_matches", case-insensitive, all the distinctive terms in a single alternation. The file names are session ids (a file under <sessionId>/subagents/ belongs to that session). Return those session ids directly as "id" — they are mapped to rows for you, and ids with no row (automated runs) are dropped. If a session matched only a generic term, leave it out.

Status vocabulary: inbox = not started, active = working on it, paused, blocked = stuck, done, dropped. Honour constraints in the query (e.g. "open", "last week", a project name).

Return every row that genuinely matches, best match first. Do not pad with weak matches; an empty list is a fine answer. "id" is the row id from the board, or a session id if that is what you found. "why" is at most 20 words saying what matched — concrete, not a restatement of the title.`;
}

// The panel shows what Claude is doing, so a regex has to read as words:
// "\$inc.{0,200}(null|parent)" -> "$inc null · parent".
function humanPattern(p) {
  const terms = String(p || '')
    .replace(/\[[^\]]*\]([*+?]|\{\d*,?\d*\})?/g, ' ')   // character classes
    .replace(/\.(\*|\+|\?|\{\d*,?\d*\})/g, ' ')          // wildcards
    .replace(/\(\?[:=!i]+/g, '(')                        // group flags
    .replace(/\\([^\w\s])/g, '$1')                        // escapes
    .replace(/\\[bBswdSWD]/g, ' ')
    .replace(/[\^()]|\$(?=\||\)|$)/g, ' ')
    .split('|').map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (terms.length && terms.every((t) => /^[0-9a-f-]{8,}$/i.test(t))) return null;
  return [...new Set(terms)].join(' · ');
}

function describeTool(name, input) {
  const i = input || {};
  const where = String(i.path || i.file_path || i.glob || '');
  const kind = /\/memory(\/|$)/.test(where) || /memory/.test(String(i.glob || '')) ? 'memory'
    : where.startsWith(PROJECTS_DIR) ? 'transcripts' : 'catalog';
  if (name === 'Grep') {
    const words = humanPattern(i.pattern);
    if (!words) return 'Matching sessions to items';
    return `${{ memory: 'Searching memory notes', transcripts: 'Searching transcripts', catalog: 'Searching the catalog' }[kind]} for “${clip(words, 70)}”`;
  }
  if (name === 'Read') return { memory: 'Reading a memory note', transcripts: 'Reading a transcript', catalog: 'Reading the catalog' }[kind];
  if (name === 'Glob') return 'Listing files';
  if (name === 'StructuredOutput') return 'Ranking results';
  return name;
}

// Resolve whatever Claude answered with (row id, full session id, or an
// 8-char prefix) to a row on the board. Unknown ids — a headless run, a
// transcript with no row — are dropped rather than shown as broken results.
function resolveMatches(matches, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bySession = new Map();
  for (const r of rows) {
    for (const s of r.sessions) bySession.set(s.sessionId, r);
    for (const id of r.sessionIds || []) bySession.set(id, r);
  }
  const out = [];
  const seen = new Set();
  for (const m of matches || []) {
    const raw = String(m.id || '').trim().replace(/\.jsonl$/, '');
    let r = byId.get(raw) || byId.get('v:' + raw) || bySession.get(raw.replace(/^v:/, ''));
    if (!r && /^[0-9a-f]{8}$/i.test(raw)) {
      for (const [sid, row] of bySession) if (sid.startsWith(raw)) { r = row; break; }
    }
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, why: String(m.why || '') });
  }
  return out;
}

// Streams progress to `emit` and resolves when the run ends. Returns a handle
// whose cancel() kills the run — the caller wires it to the client going away.
function run(query, emit) {
  const { rows, initiatives } = view.build();
  const initNames = Object.fromEntries(initiatives.map((i) => [i.id, i.name]));
  const terse = writeCatalog(rows, initNames);

  const args = [
    '-p', prompt(query, terse, new Date().toISOString().slice(0, 10)),
    '--safe-mode', '--no-session-persistence',
    '--model', MODEL, '--effort', EFFORT,
    '--tools', TOOLS, '--allowedTools', TOOLS, '--permission-mode', 'dontAsk',
    '--add-dir', PROJECTS_DIR,
    '--output-format', 'stream-json', '--verbose',
    '--json-schema', SCHEMA,
  ];
  const child = spawn(claudeBin(), args, { cwd: WORK_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  let stderr = '';
  let done = false;
  const finish = (ev) => { if (done) return; done = true; emit(ev); };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'assistant') {
        for (const c of (o.message && o.message.content) || []) {
          if (c.type === 'tool_use') emit({ type: 'progress', text: describeTool(c.name, c.input) });
        }
      } else if (o.type === 'result') {
        if (o.is_error || !o.structured_output) {
          finish({ type: 'error', error: clip(o.result || o.subtype || 'search failed', 300) });
        } else {
          finish({ type: 'result', matches: resolveMatches(o.structured_output.matches, rows),
            costUsd: o.total_cost_usd || 0, ms: o.duration_ms || 0 });
        }
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
  child.on('error', (e) => finish({ type: 'error', error: 'could not start claude: ' + e.message }));
  child.on('close', (code) => finish({ type: 'error', error: clip(stderr, 300) || `claude exited (${code})` }));

  emit({ type: 'progress', text: `Reading ${rows.length} items` });
  return { cancel: () => { done = true; try { child.kill('SIGTERM'); } catch {} } };
}

module.exports = { run };
