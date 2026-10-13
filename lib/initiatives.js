'use strict';
// Initiatives are THEMATIC groupings, not repos. An item lands in one by
// explicit assignment (overlay) or, failing that, by weighted keyword match.
// Initiatives and their rules live only in data/initiatives.json (not source
// controlled — they are personal). A fresh install starts with none; create
// them from the sidebar.

const fs = require('fs');
const path = require('path');
const { WB_DIR } = require('./paths');

const FILE = path.join(WB_DIR, 'data', 'initiatives.json');

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && Array.isArray(raw.initiatives) && raw.initiatives.length) return raw;
  } catch {}
  return { version: 1, initiatives: [] };
}

function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

// Score a haystack against every initiative; highest weight wins.
function classify(text, initiatives) {
  const hay = ' ' + String(text || '').toLowerCase() + ' ';
  let best = null, bestScore = 0;
  for (const ini of initiatives) {
    if (ini.archived) continue;
    let score = 0;
    for (const [kw, w] of ini.rules || []) {
      if (hay.includes(kw)) score += w;
    }
    if (score > bestScore) { bestScore = score; best = ini.id; }
  }
  return bestScore >= 3 ? { id: best, score: bestScore } : { id: null, score: bestScore };
}

module.exports = { load, save, classify, FILE };
