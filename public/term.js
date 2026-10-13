'use strict';
/* Bottom dock of live terminals. tmux owns the session; this is just a viewport.
   Closing a tab ENDS the session (it can be resumed from the board); ⌥-click
   detaches instead, leaving the tmux session running for iTerm to pick up. */
(function () {
  const Term = window.WBTerm = {
    tabs: [], active: null, open: openTab, dock: null, maximized: false, height: 380,
  };

  const THEME_DARK = {
    background: '#141821', foreground: '#dfe4ef', cursor: '#8ab4ff', cursorAccent: '#141821',
    selectionBackground: '#2f3b52', black: '#1b2029', red: '#ff6b81', green: '#6ee7a8',
    yellow: '#ffcf6b', blue: '#79b8ff', magenta: '#d6a2ff', cyan: '#7fe3e0', white: '#dfe4ef',
    brightBlack: '#5b667c', brightRed: '#ff8b9c', brightGreen: '#93f4c2', brightYellow: '#ffe08a',
    brightBlue: '#a2cfff', brightMagenta: '#e6c2ff', brightCyan: '#a8f0ee', brightWhite: '#ffffff',
  };
  const THEME_LIGHT = {
    background: '#ffffff', foreground: '#232733', cursor: '#3b5bdb', cursorAccent: '#ffffff',
    selectionBackground: '#d7e3ff', black: '#232733', red: '#c92a45', green: '#1a7f4b',
    yellow: '#9a6700', blue: '#2f5fd0', magenta: '#8b3fc4', cyan: '#0f7a86', white: '#e8ebf2',
    brightBlack: '#6b7484', brightRed: '#e03e58', brightGreen: '#23a163', brightYellow: '#b8860b',
    brightBlue: '#4478e8', brightMagenta: '#a45ae0', brightCyan: '#1897a6', brightWhite: '#ffffff',
  };
  // The terminal is allowed to disagree with the page: a dark pane reads better
  // even when the rest of the app is light, so data-term overrides data-theme here.
  const isDark = () => {
    const d = document.documentElement.dataset;
    if (d.term === 'dark') return true;
    if (d.term === 'light') return false;
    return d.theme === 'dark' || (!d.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  };
  // The dock's own box has to track the terminal, not the page, or a dark pane sits
  // in a light frame with a bright halo around it. xterm's background is the single
  // source of truth for both, published as a variable the stylesheet can read.
  const termTheme = () => {
    const th = isDark() ? THEME_DARK : THEME_LIGHT;
    document.documentElement.style.setProperty('--term-bg', th.background);
    return th;
  };
  termTheme();

  // navigator.clipboard is undefined on non-secure origins such as http://claude.local,
  // so fall back to the legacy path rather than silently failing there.
  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
  Term.copyText = copyText;

  function h(tag, attrs, kids) {
    const n = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
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

  function ensureDock() {
    if (Term.dock) return Term.dock;
    const grip = h('div', { class: 'tdock-grip', title: 'Drag to resize' });
    const tabs = h('div', { class: 'tdock-tabs' });
    const body = h('div', { class: 'tdock-body' });
    const status = h('div', { class: 'tdock-status' });
    const dock = h('section', { class: 'tdock', hidden: 'hidden' }, [
      grip,
      h('div', { class: 'tdock-bar' }, [
        tabs,
        h('span', { class: 'grow' }),
        status,
        h('button', { class: 'btn ghost sm', text: '⤢', title: 'Maximize', onclick: toggleMax }),
        h('button', { class: 'btn ghost sm', text: '✕', title: 'Hide dock (sessions keep running)', onclick: hideDock }),
      ]),
      body,
    ]);
    (document.querySelector('.main') || document.body).appendChild(dock);
    Object.assign(Term, { dock, _tabs: tabs, _body: body, _status: status });

    let drag = null;
    grip.addEventListener('mousedown', (e) => { drag = { y: e.clientY, h: Term.height }; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      Term.height = Math.max(160, Math.min(window.innerHeight - 90, drag.h + (drag.y - e.clientY)));
      applyHeight();
    });
    window.addEventListener('mouseup', () => { if (drag) { drag = null; fitActive(); } });
    window.addEventListener('resize', fitActive);
    return dock;
  }

  function applyHeight() {
    if (!Term.dock) return;
    if (document.body.dataset.mode === 'work') {
      Term.dock.style.height = '';
      document.body.style.setProperty('--dock-h', '0px');
      return;
    }
    Term.dock.style.height = Term.maximized ? 'calc(100vh - 8px)' : Term.height + 'px';
    document.body.style.setProperty('--dock-h', (Term.dock.hidden ? 0 : (Term.maximized ? window.innerHeight - 8 : Term.height)) + 'px');
  }
  function toggleMax() { Term.maximized = !Term.maximized; applyHeight(); setTimeout(fitActive, 60); }
  function hideDock() { if (Term.dock) { Term.dock.hidden = true; applyHeight(); } }
  function showDock() { ensureDock().hidden = false; applyHeight(); setTimeout(fitActive, 60); }

  function fitActive() {
    const t = Term.tabs.find((x) => x.id === Term.active);
    if (!t || Term.dock.hidden) return;
    try {
      t.fit.fit();
      if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ t: 'r', c: t.term.cols, r: t.term.rows }));
    } catch {}
  }

  function send(tab, data) {
    if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify({ t: 'i', d: data }));
  }
  Term.send = send;

  // Dropping a file gives the browser a name, a size and an mtime but never a
  // path, so the server resolves it (Spotlight) or keeps the bytes. Either way
  // what lands in the prompt is a path that can actually be opened.
  async function pathForDrop(file) {
    const body = JSON.stringify({ name: file.name, size: file.size, mtime: file.lastModified });
    try {
      const r = await fetch('/api/drop/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const j = await r.json();
      if (j.path) return { path: j.path, saved: false };
    } catch {}
    try {
      const r = await fetch('/api/drop/save', { method: 'POST', headers: { 'x-drop-name': encodeURIComponent(file.name).replace(/%20/g, ' ') }, body: file });
      const j = await r.json();
      if (j.path) return { path: j.path, saved: true };
    } catch {}
    return null;
  }

  // Text drags (a Finder alias, another terminal, a file:// URL) already carry
  // the path — take it verbatim rather than round-tripping through the server.
  function pathsFromText(dt) {
    const raw = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
    return raw.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        if (l.startsWith('file://')) { try { return decodeURI(l.replace(/^file:\/\/[^/]*/, '')); } catch { return null; } }
        return l.startsWith('/') || l.startsWith('~') ? l : null;
      })
      .filter(Boolean);
  }

  function dropTarget(el, tab) {
    const over = (e) => {
      if (!e.dataTransfer) return;
      const kinds = [...e.dataTransfer.types];
      if (!kinds.includes('Files') && !kinds.includes('text/uri-list') && !kinds.includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('drop-on');
    };
    el.addEventListener('dragover', over);
    el.addEventListener('dragenter', over);
    el.addEventListener('dragleave', (e) => { if (e.target === el) el.classList.remove('drop-on'); });
    el.addEventListener('drop', async (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      el.classList.remove('drop-on');

      let paths = pathsFromText(e.dataTransfer);
      if (!paths.length) {
        const files = [...(e.dataTransfer.files || [])];
        if (!files.length) return;
        if (window.WBToast) window.WBToast(`Resolving ${files.length} file${files.length > 1 ? 's' : ''}…`);
        const out = await Promise.all(files.map(pathForDrop));
        const kept = out.filter(Boolean);
        if (!kept.length) return window.WBToast && window.WBToast('Could not work out where that file lives');
        if (kept.some((k) => k.saved) && window.WBToast) window.WBToast('Copied into ~/.claude/workbench/data/drops');
        paths = kept.map((k) => k.path);
      }
      if (!paths.length) return;
      // Bracketed paste: the TUI must see one paste, not a burst of keystrokes.
      send(tab, '\x1b[200~' + paths.join(' ') + '\x1b[201~');
      tab.term.focus();
    });
  }

  function openTab(session, opts) {
    if (!window.Terminal) { alert('Terminal assets missing'); return; }
    ensureDock(); showDock();
    const id = session.sessionId;
    const existing = Term.tabs.find((t) => t.id === id);
    if (existing) { activate(id); return existing; }

    const wrap = h('div', { class: 'tdock-pane' });
    Term._body.appendChild(wrap);

    const term = new window.Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, scrollback: 8000,
      allowProposedApi: true, theme: termTheme(),
      // The Claude TUI turns on mouse tracking, so a plain drag is sent to the app
      // instead of selecting. On macOS this makes Option+drag select locally.
      macOptionClickForcesSelection: true,
      // MUST stay false: xterm's contextmenu handler REPLACES the current selection
      // with the word under the pointer and stuffs that word into the hidden textarea
      // the browser's Copy reads from — so right-clicking a drag-selection copied one
      // word and threw the rest away. The contextmenu listener below copies instead.
      rightClickSelectsWord: false,
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(wrap);
    try { fit.fit(); } catch {}

    const tab = { id, session, term, fit, el: wrap, ws: null, title: session.title || id.slice(0, 8), status: 'connecting' };

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'c' && term.hasSelection()) {
        copyText(term.getSelection());
        if (window.WBToast) window.WBToast('Copied selection');
        return false;      // do not also send ^C to the app
      }
      // xterm.js sends a bare CR for Enter no matter which modifiers are held,
      // which the Claude TUI reads as "submit". ESC+CR is the newline sequence
      // `claude /terminal-setup` installs in real terminals, so send that.
      if (ev.key === 'Enter' && (ev.shiftKey || ev.altKey) && !ev.metaKey && !ev.ctrlKey) {
        // Returning false only stops xterm; Enter still raises a keypress that
        // xterm turns into a bare CR, so the TUI would submit anyway. Cancel the
        // event outright — this is the difference between working and not.
        ev.preventDefault();
        ev.stopPropagation();
        send(tab, '\x1b\r');
        return false;
      }
      return true;
    });

    // Selection here is the fallback path: while the socket is live tmux owns the
    // drag (yellow, copy-pipe to pbcopy on release) because it keeps ?1002h on
    // toward the browser, which makes xterm disable its own selection. xterm only
    // selects when Option is held or when nothing is attached — and those cases
    // used to select and then silently drop it. Copy on release either way, so a
    // drag always ends with the text on the clipboard.
    const copySelection = (why) => {
      if (!term.hasSelection()) return false;
      const text = term.getSelection();
      if (!text) return false;
      copyText(text).then((ok) => {
        if (window.WBToast) window.WBToast(ok ? `Copied selection (${why})` : 'Copy blocked by the browser');
      });
      return true;
    };
    wrap.addEventListener('mouseup', () => setTimeout(() => copySelection('drag'), 0));
    wrap.addEventListener('contextmenu', (ev) => {
      // Only swallow the native menu when there is something of our own to copy.
      if (copySelection('right-click')) ev.preventDefault();
    });

    dropTarget(wrap, tab);
    // Registered once per tab and routed through tab.ws, so a reconnect does
    // not stack a second sender on top of the first.
    term.onData((d) => { if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify({ t: 'i', d })); });
    term.onResize(({ cols, rows }) => { if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify({ t: 'r', c: cols, r: rows })); });
    Term.tabs.push(tab);
    activate(id);
    connect(tab, opts || {});
    return tab;
  }

  // The socket dies whenever the Mac sleeps or Chrome throttles a background
  // tab; the tmux session does not. Re-attach instead of making the person
  // reload — immediately on wake/focus, with backoff otherwise.
  function scheduleReconnect(tab) {
    if (tab.gone || tab.status === 'ended' || tab.retry) return;
    const n = tab.attempts = (tab.attempts || 0) + 1;
    const delay = Math.min(15000, 500 * Math.pow(2, n - 1));
    tab.retry = setTimeout(() => { tab.retry = null; connect(tab, {}); }, delay);
  }
  function reconnectAll() {
    Term.tabs.forEach((t) => {
      if (t.gone || t.status === 'ended' || t.status === 'connecting') return;
      if (t.ws && t.ws.readyState === 1) return;
      if (t.retry) { clearTimeout(t.retry); t.retry = null; }
      t.attempts = 0;
      connect(t, {});
    });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectAll(); });
  window.addEventListener('focus', reconnectAll);
  window.addEventListener('online', reconnectAll);
  window.addEventListener('pageshow', reconnectAll);

  function connect(tab, opts) {
    const q = new URLSearchParams({
      sessionId: tab.id, cols: String(tab.term.cols || 120), rows: String(tab.term.rows || 30),
    });
    if (tab.session.cwd) q.set('cwd', tab.session.cwd);
    if (opts.fork) q.set('fork', '1');

    const ws = new WebSocket(`ws://${location.host}/ws/term?` + q.toString());
    ws.binaryType = 'arraybuffer';
    tab.ws = ws;
    tab.status = 'connecting';
    renderTabs();

    const dec = new TextDecoder();
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'ready') { tab.status = 'live'; tab.attempts = 0; tab.tmux = m.tmux; renderTabs(); setTimeout(fitActive, 80); }
        else if (m.t === 'err') { term_write(tab, `\r\n\x1b[31m${m.m}\x1b[0m\r\n`); }
        else if (m.t === 'exit') { tab.status = 'ended'; renderTabs(); term_write(tab, '\r\n\x1b[90m— detached —\x1b[0m\r\n'); }
        return;
      }
      tab.term.write(dec.decode(new Uint8Array(ev.data), { stream: true }));
    };
    ws.onclose = () => {
      if (tab.ws !== ws) return;             // superseded by a newer socket
      if (tab.status !== 'ended') { tab.status = 'closed'; renderTabs(); scheduleReconnect(tab); }
    };
    ws.onerror = () => { if (tab.ws === ws) { tab.status = 'error'; renderTabs(); } };
  }
  const term_write = (tab, s) => { try { tab.term.write(s); } catch {} };

  function activate(id) {
    Term.active = id;
    Term.tabs.forEach((t) => { t.el.style.display = t.id === id ? 'block' : 'none'; });
    renderTabs();
    const t = Term.tabs.find((x) => x.id === id);
    if (t) { setTimeout(() => { try { t.fit.fit(); t.term.focus(); } catch {} }, 40); }
  }

  function closeTab(id) {
    const i = Term.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const t = Term.tabs[i];
    t.gone = true;
    if (t.retry) { clearTimeout(t.retry); t.retry = null; }
    try { t.ws && t.ws.close(); } catch {}
    try { t.term.dispose(); } catch {}
    t.el.remove();
    Term.tabs.splice(i, 1);
    if (Term.active === id) {
      const next = Term.tabs[Math.max(0, i - 1)];
      if (next) activate(next.id); else { Term.active = null; hideDock(); }
    }
    renderTabs();
  }

  // The ✕ ends the work. A session can always be resumed from the board, so an
  // abandoned tmux container is pure clutter — but a turn in flight is not
  // recoverable, so that case asks first.
  async function endTab(id, rect) {
    let st = {};
    try {
      const r = await fetch('/api/session/status?sessionId=' + encodeURIComponent(id));
      st = await r.json();
    } catch {}
    const finish = async () => {
      try { await fetch('/api/session/end', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: id }),
      }); } catch {}
      closeTab(id);
      if (window.WBToast) window.WBToast('Session ended · resume it from the board');
      if (window.WBReload) window.WBReload();
    };
    if (st.busy && window.WBConfirm) {
      const at = rect || (Term._tabs ? Term._tabs.getBoundingClientRect() : null);
      window.WBConfirm(at, 'Claude is still working in this session. Ending it now loses the turn in progress.',
        'End it anyway', finish);
      return;
    }
    await finish();
  }

  function renderTabs() {
    if (!Term._tabs) return;
    Term._tabs.innerHTML = '';
    Term.tabs.forEach((t) => {
      Term._tabs.appendChild(h('div', {
        class: 'ttab' + (t.id === Term.active ? ' on' : ''), onclick: () => activate(t.id),
      }, [
        h('span', { class: 'tdot ' + t.status, title: t.status }),
        h('span', { class: 'tnm', text: t.title }),
        h('button', { class: 'tx', text: '✕', title: 'End this session (⌥ to detach and leave it running)',
          onclick: (e) => {
            e.stopPropagation();
            const at = e.currentTarget.getBoundingClientRect();
            if (e.altKey) { closeTab(t.id); return; }
            endTab(t.id, at);
          } }),
      ]));
    });
    const a = Term.tabs.find((t) => t.id === Term.active);
    Term._status.textContent = a ? [a.tmux || '', a.session.cwd || ''].filter(Boolean).join('  ·  ') : '';
    if (typeof Term.onchange === 'function') Term.onchange();
  }

  Term.retheme = () => {
    const th = termTheme();
    Term.tabs.forEach((t) => { try { t.term.options.theme = th; } catch {} });
  };
  // Tab titles are a view of the board, not a snapshot taken at open time:
  // an ai-title arriving or a rename has to show up here.
  Term.setTitle = (id, title) => {
    const t = Term.tabs.find((x) => x.id === id);
    if (!t || !title || t.title === title) return false;
    t.title = title;
    renderTabs();
    return true;
  };
  // Is a turn in flight? An open tab already holds the pane on screen, so read it
  // there instead of asking the server: the TUI keeps "esc to interrupt" in its
  // footer for exactly as long as it is working, and this stays current between
  // board refreshes instead of going stale for 30 seconds.
  Term.isBusy = (tab) => {
    if (!tab || !tab.term) return false;
    const b = tab.term.buffer.active;
    const end = b.baseY + tab.term.rows - 1;
    for (let i = end; i >= 0 && i > end - 8; i--) {
      const line = b.getLine(i);
      if (line && line.translateToString(true).indexOf('esc to interrupt') >= 0) return true;
    }
    return false;
  };

  Term.closeTab = closeTab;
  Term.endTab = endTab;
  Term.show = showDock;
  Term.hide = hideDock;
  Term.activate = activate;
  Term.fit = fitActive;
  Term.applyHeight = applyHeight;
})();
