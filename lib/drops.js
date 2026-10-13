'use strict';
// Turning a browser drop back into a real filesystem path.
//
// A browser hands JavaScript a File with a name, a size and an mtime — never the
// path it came from. On macOS Spotlight knows every path a given name lives at,
// so ask it and then confirm the candidate really is the file that was dropped.
// If nothing matches (dragged out of another browser, an unindexed volume) the
// bytes are kept instead, so what we paste always points at something readable.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { WB_DIR } = require('./paths');

const DROP_DIR = path.join(WB_DIR, 'data', 'drops');
const MAX_SAVE = 256 * 1024 * 1024;

// Spotlight query strings are single-quoted; a name containing one would break
// out of the literal, so those names go unresolved rather than half-escaped.
function spotlight(name) {
  if (name.includes("'") || name.includes('\\')) return [];
  try {
    const out = execFileSync('/usr/bin/mdfind', [`kMDItemFSName == '${name}'`],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

// Same name AND same size AND an mtime within a second (browsers round it).
function matches(p, size, mtime) {
  let st;
  try { st = fs.statSync(p); } catch { return false; }
  if (st.isDirectory()) return !size;
  if (typeof size === 'number' && st.size !== size) return false;
  if (typeof mtime === 'number' && mtime > 0 && Math.abs(st.mtimeMs - mtime) > 1500) return false;
  return true;
}

function resolve({ name, size, mtime }) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..') return null;

  const hits = spotlight(base).filter((p) => matches(p, size, mtime));
  // Two files that agree on name, size and mtime are indistinguishable from
  // here — guessing between them would paste the wrong path half the time.
  if (hits.length !== 1) return null;
  return hits[0];
}

// Names arrive from the browser, so keep only a basename and refuse anything
// that could still escape the drop directory.
function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[/\0]/g, '');
  if (!base || base === '.' || base === '..') return 'dropped-file';
  return base.slice(0, 120);
}

function save(name, stream) {
  return new Promise((res, rej) => {
    fs.mkdirSync(DROP_DIR, { recursive: true });
    const base = safeName(name);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(DROP_DIR, stamp + '-' + base);
    if (!dest.startsWith(DROP_DIR + path.sep)) return rej(new Error('bad name'));

    const out = fs.createWriteStream(dest);
    let written = 0;
    stream.on('data', (c) => {
      written += c.length;
      if (written > MAX_SAVE) { stream.destroy(); out.destroy(); try { fs.unlinkSync(dest); } catch {} rej(new Error('file too large')); }
    });
    stream.on('error', rej);
    out.on('error', rej);
    out.on('finish', () => res(dest));
    stream.pipe(out);
  });
}

module.exports = { resolve, save, DROP_DIR };
