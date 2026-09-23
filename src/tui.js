// Small-screen-friendly terminal UI. No mouse, no framework; raw stdin + ANSI.
//
// Rendering: full-screen alternate buffer, cursor home + per-line erase on every
// frame, so each repaint lands in the same place (no scrolling / stacked
// headers), and SIGWINCH refits live. Colour comes from mcode's OWN `minimax`
// theme palette (see theme.js), degrading through truecolor -> 256 -> 16 ->
// plain. `--no-color` emits no SGR at all; `--ascii` uses plain-ASCII glyphs.
//
// Scrolling: windowed. Only one screen-full of rows is fetched at a time and
// the next/previous window loads as the cursor reaches the edge; the footer
// always shows x(current)/y(total), and pushing past either end wraps around.
import { spawn } from 'node:child_process';
import { Discovery } from './discovery.js';
import { Lifecycle } from './lifecycle.js';
import { Inspector } from './inspect.js';
import { SqliteAdapter } from './sqlite.js';
import { MCODE_BIN, dbExists, mcodeBinExists } from './env.js';
import { Theme, dispWidth, padTo, clipTo } from './theme.js';
import { trunc as truncShared, shortWs, relAge, iso, fitLR } from './format.js';

const GLYPHS_ASCII = { h: '-', v: '|', arrow: '>', ok: 'ok', warn: '!', up: '^', down: 'v', cursor: '_' };
const GLYPHS_UNICODE = { h: '─', v: '│', arrow: '›', ok: '✓', warn: '⚠', up: '↑', down: '↓', cursor: '▏' };

const ACTION_MENU = [
  ['1', 'open / resume'],
  ['2', 'rename'],
  ['3', 'archive'],
  ['4', 'unarchive'],
  ['5', 'fork / clone'],
  ['6', 'delete'],
  ['7', 'inspect'],
  ['8', 'export'],
  ['9', 'usage / stats'],
  ['0', 'back'],
];
const DEFAULT_MENU_IDX = 6; // 'inspect' — never 'delete'

// status string -> mcode colour role
function statusRole(s) {
  if (s === 'started') return 'signal';
  if (s === 'error') return 'error';
  if (s === 'aborted') return 'warning';
  return 'dim';
}

export async function runTui({ flags, log }) {
  if (!dbExists()) {
    process.stderr.write('runtime database not found. Set MSM_RUNTIME_DATA_DIR or check the install.\n');
    return 2;
  }
  const t = new Tui({ flags, log });
  try { return await t.run(); }
  finally { t.destroy(); }
}

export class Tui {
  constructor({ flags, log }) {
    this.flags = flags;
    this.log = log;
    this.theme = new Theme({ color: flags.color });
    this.color = this.theme.on; // kept for compatibility
    this.glyphs = flags.ascii ? GLYPHS_ASCII : GLYPHS_UNICODE;
    this.db = new SqliteAdapter({ log });
    this.discovery = new Discovery({ log, db: this.db });
    this.lifecycle = new Lifecycle({ log, db: this.db });
    this.inspector = new Inspector({ log, db: this.db });

    this.screen = 'browser';
    this.cursor = 0;      // index into the current window of rows
    this.offset = 0;      // absolute index of rows[0] within the filtered set
    this.rows = [];
    this.total = 0;
    this.filters = { archived: flags.includeArchived === false ? 'exclude' : 'include' };
    this.selected = null;
    this.message = '';
    this.messageKind = 'info';
    this.inputPrompt = '';
    this.inputBuf = '';
    this.inputCb = null;
    this.outputText = '';
    this.outputTitle = '';
    this.filterKind = null;
    this.foptions = [];
    this.fcursor = 0;
    this.prevScreen = 'browser';
    this._menuIdx = DEFAULT_MENU_IDX;
    this.deleteTarget = null;
    this.deletePlan = null;
    this.confirmToken = '';
    this.pendingExec = null;
    this._resolve = null;
    this._alt = false;   // alternate screen buffer entered?
    this._prevLines = null; // previous frame, for minimal in-place repainting
    this._outputScroll = 0;
    this.searchBuf = '';
    this.searchRows = null;
    this._searchKey = null;
    this._facets = { archived: 0, active: 0 };
  }

  async run() {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      process.stderr.write('mcode-sessions TUI requires a TTY. Use the CLI subcommands instead.\n');
      return 2;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    this._restore = () => { try { stdin.setRawMode(false); } catch {} };
    process.on('SIGINT', () => this.quit(0));
    // refit on resize: the page size changes, so reload the window and repaint.
    // The previous frame is dropped so the next render is a full repaint (the
    // terminal may have rewrapped everything, so a diff would be wrong).
    this._sigwinch = () => { this._prevLines = null; this.refresh(); this.render(); };
    process.on('SIGWINCH', this._sigwinch);

    this.refresh();
    this.render();
    stdin.on('data', d => this.onKey(d));
    return new Promise(resolve => { this._resolve = resolve; });
  }

  quit(code) {
    if (this._restore) this._restore();
    try { process.stdin.removeAllListeners('data'); process.stdin.pause(); } catch {}
    this._leaveAlt();
    if (this.pendingExec) {
      const { args, cwd } = this.pendingExec;
      process.stdout.write(`launching: mcode ${args.join(' ')}${cwd ? `  (cwd: ${cwd})` : ''}\n`);
      try {
        // mcode's top-level CLI has no --cwd flag; the workspace is set via
        // the child process cwd (the session already stores workspace_dir).
        const child = spawn(MCODE_BIN, args, { stdio: 'inherit', cwd: cwd || undefined });
        child.on('exit', c => this._done(c ?? 0));
        child.on('error', () => this._done(code));
        return;
      } catch { this._done(code); return; }
    }
    this._done(code);
  }
  _done(code) { if (this._resolve) { const r = this._resolve; this._resolve = null; r(code); } }
  _leaveAlt() {
    this._prevLines = null;
    if (this._alt) { this._alt = false; process.stdout.write('\x1b[?25h\x1b[?1049l\x1b[H\x1b[2J'); }
  }
  destroy() { this._leaveAlt(); try { this.db.close(); } catch {} }

  get width() { return Math.max(20, process.stdout.columns || 80); }
  get height() { return Math.max(6, process.stdout.rows || 24); }
  // rows available for list content after header/footer chrome
  get pageSize() {
    // browser chrome: header + rule + rule + pos + hint = 5
    return Math.max(1, this.height - 5);
  }

  onKey(chunk) {
    for (const k of decodeKeys(chunk)) {
      if (this.screen === 'search') this.handleSearchKey(k);
      else if (this.screen === 'input') this.handleInputKey(k);
      else if (this.screen === 'confirm') this.handleConfirmKey(k);
      else if (this.screen === 'output') this.handleOutputKey(k);
      else if (this.screen === 'filter') this.handleFilterKey(k);
      else if (this.screen === 'menu') this.handleMenuKey(k);
      else this.handleBrowserKey(k);
    }
  }

  // ------------------------------------------------------------- browser
  handleBrowserKey(k) {
    const n = this.rows.length;
    if (k.name === 'ctrlc') return this.quit(0);
    if (k.name === 'escape') return;
    if (k.char === 'q') return this.quit(0);
    if (k.name === 'up' || k.char === 'k') return this.moveUp();
    if (k.name === 'down' || k.char === 'j') return this.moveDown();
    if (k.name === 'right' || k.char === 'l') return this.moveDown();
    if (k.name === 'left' || k.char === 'h') return this.moveUp();
    if (k.name === 'home' || k.char === 'g') return this.goTop();
    if (k.name === 'end' || k.char === 'G') return this.goBottom();
    if (k.name === 'pgdn' || k.name === 'space' || k.char === 'n') return this.nextPage();
    if (k.name === 'pgup' || k.char === 'b' || k.char === 'p') return this.prevPage();
    if (k.name === 'enter') return this.openMenu(this.rows[this.cursor]);
    if (k.char === '/') return this.beginSearch();
    if (k.char === 'r') { this.message = 'refreshed'; this.messageKind = 'info'; this.refresh(); return this.render(); }
    if (k.char === 'a') return this.cycleArchived();
    if (k.char === 's') return this.openFilter('status');
    if (k.char === 't') return this.openFilter('kind');
    if (k.char === 'w') return this.openFilter('workspace');
    if (k.char === 'x') return this.clearFilters();
    if (k.char && /[1-9]/.test(k.char)) { const idx = Number(k.char) - 1; if (idx < n) return this.openMenu(this.rows[idx]); }
    if (k.char === '0') { if (9 < n) return this.openMenu(this.rows[9]); }
  }

  // windowed scrolling ------------------------------------------------
  // Only `pageSize` rows are held at once. Reaching the edge loads the next or
  // previous window; pushing past the last/first row wraps to the other end.
  moveDown() {
    const n = this.rows.length;
    if (n === 0) return;
    if (this.cursor < n - 1) { this.cursor++; return this.render(); }
    if (this.offset + n < this.total) { this.offset += n; this.refresh(); this.cursor = 0; return this.render(); }
    return this.goTop(); // past the end -> wrap to the top
  }
  moveUp() {
    const n = this.rows.length;
    if (n === 0) return;
    if (this.cursor > 0) { this.cursor--; return this.render(); }
    if (this.offset > 0) { this.offset = Math.max(0, this.offset - this.pageSize); this.refresh(); this.cursor = this.rows.length - 1; return this.render(); }
    return this.goBottom(); // above the top -> wrap to the bottom
  }
  goTop() { this.offset = 0; this.refresh(); this.cursor = 0; this.render(); }
  goBottom() {
    const ps = this.pageSize;
    this.offset = Math.max(0, (Math.ceil(this.total / ps) - 1) * ps);
    this.refresh();
    this.cursor = Math.max(0, this.rows.length - 1);
    this.render();
  }
  nextPage() {
    const ps = this.pageSize;
    if (this.offset + this.rows.length < this.total) { this.offset = Math.min(this.offset + ps, Math.max(0, this.total - 1)); this.refresh(); this.cursor = 0; }
    else this.goTop();
    this.render();
  }
  prevPage() {
    if (this.offset > 0) { this.offset = Math.max(0, this.offset - this.pageSize); this.refresh(); this.cursor = 0; }
    else this.goBottom();
    this.render();
  }

  cycleArchived() {
    const order = ['include', 'exclude', 'only'];
    this.filters.archived = order[(order.indexOf(this.filters.archived ?? 'include') + 1) % 3];
    this.offset = 0; this.cursor = 0; this.refresh(); this.render();
  }
  clearFilters() { this.filters = { archived: 'include' }; this.offset = 0; this.cursor = 0; this.refresh(); this.message = 'filters cleared'; this.messageKind = 'info'; this.render(); }

  openFilter(kind) {
    this.filterKind = kind;
    let opts;
    if (kind === 'status') opts = this.discovery.statuses().map(r => ({ v: r.status, label: `${r.status} (${r.n})` }));
    else if (kind === 'kind') opts = this.discovery.kinds().map(r => ({ v: r.session_kind, label: `${r.session_kind} (${r.n})` }));
    else opts = this.discovery.workspaces().map(r => ({ v: r.workspace_dir, label: `${r.workspace_dir} (${r.n})` }));
    this.foptions = [{ v: null, label: '(all)' }, ...opts];
    this.fcursor = 0;
    this.prevScreen = 'browser';
    this.screen = 'filter';
    this.render();
  }
  applyFilter(opt) {
    const kind = this.filterKind;
    if (!opt || opt.v == null) delete this.filters[kind];
    else this.filters[kind] = opt.v;
    this.offset = 0; this.cursor = 0; this.refresh();
    this.screen = 'browser';
    this.render();
  }

  // -------------------------------------------------------------- search
  // live: results filter on every keystroke, enter commits, esc discards
  beginSearch() {
    this.searchBuf = this.filters.q ?? '';
    this.searchRows = null;
    this.prevScreen = 'browser';
    this.screen = 'search';
    this.render();
  }
  get searchResults() {
    const q = this.searchBuf.trim();
    const key = q + '\u0000' + JSON.stringify(this.filters.archived);
    if (this.searchRows && this._searchKey === key) return this.searchRows;
    this._searchKey = key;
    const { rows, total } = this.discovery.list({
      limit: this.pageSize, offset: 0,
      filters: { ...this.filters, ...(q ? { q } : {}) },
    });
    this.searchRows = { rows, total, q };
    return this.searchRows;
  }
  handleSearchKey(k) {
    if (k.name === 'ctrlc') return this.quit(0);
    if (k.name === 'escape') { this.screen = 'browser'; return this.render(); }
    if (k.name === 'backspace') { this.searchBuf = this.searchBuf.slice(0, -1); this.searchRows = null; return this.render(); }
    if (k.name === 'enter') {
      const q = this.searchBuf.trim();
      if (q) this.filters.q = q; else delete this.filters.q;
      this.offset = 0; this.cursor = 0; this.refresh();
      this.screen = 'browser';
      return this.render();
    }
    if (k.char && k.char >= ' ' && k.char <= '~') { this.searchBuf += k.char; this.searchRows = null; return this.render(); }
  }

  // ---------------------------------------------------------------- menu
  handleMenuKey(k) {
    if (k.name === 'ctrlc') return this.quit(0);
    if (k.name === 'escape' || k.char === 'q' || k.name === 'backspace' || k.char === '0') { this.screen = 'browser'; return this.render(); }
    if (!this.selected) { this.screen = 'browser'; return this.render(); }
    if (k.name === 'up' || k.char === 'k') { this._menuIdx = (this._menuIdx + ACTION_MENU.length - 1) % ACTION_MENU.length; return this.render(); }
    if (k.name === 'down' || k.char === 'j') { this._menuIdx = (this._menuIdx + 1) % ACTION_MENU.length; return this.render(); }
    if (k.name === 'enter') return this.runAction(ACTION_MENU[this._menuIdx][0]);
    if (k.char && ACTION_MENU.some(([key]) => key === k.char)) return this.runAction(k.char);
  }

  async runAction(key) {
    const s = this.selected;
    if (key === '0' || !s) { this.screen = 'browser'; return this.render(); }
    if (key === '1') return this.openResume(s);
    if (key === '2') return this.beginRename(s);
    if (key === '3') return this.doArchive(s, true);
    if (key === '4') return this.doArchive(s, false);
    if (key === '5') return this.doFork(s);
    if (key === '6') return this.beginDelete(s);
    if (key === '7') return this.showInspect(s);
    if (key === '8') return this.showExport(s);
    if (key === '9') return this.showStats(s);
  }

  // -------------------------------------------------------------- confirm
  handleConfirmKey(k) {
    if (k.name === 'ctrlc') return this.quit(0);
    if (k.name === 'escape' || k.char === 'q') { this.screen = 'menu'; this.message = 'delete cancelled'; this.messageKind = 'info'; return this.render(); }
    if (k.name === 'backspace') { this.inputBuf = this.inputBuf.slice(0, -1); return this.render(); }
    if (k.name === 'enter') {
      if (this.inputBuf.trim() === this.confirmToken) return this.executeDelete();
      this.message = 'confirmation token did not match — nothing deleted';
      this.messageKind = 'warn';
      this.screen = 'menu';
      return this.render();
    }
    if (k.char && /[A-Za-z0-9_-]/.test(k.char)) { this.inputBuf += k.char; return this.render(); }
  }

  // ---------------------------------------------------------------- input
  handleInputKey(k) {
    if (k.name === 'ctrlc') return this.quit(0);
    if (k.name === 'escape') { this.screen = this.prevScreen || 'browser'; this.inputBuf = ''; return this.render(); }
    if (k.name === 'backspace') { this.inputBuf = this.inputBuf.slice(0, -1); return this.render(); }
    if (k.name === 'enter') { const v = this.inputBuf; this.inputBuf = ''; const cb = this.inputCb; this.inputCb = null; return cb ? cb(v) : undefined; }
    if (k.char && k.char >= ' ' && k.char <= '~') { this.inputBuf += k.char; return this.render(); }
  }

  // --------------------------------------------------------------- output
  handleOutputKey(k) {
    if (k.name === 'ctrlc') return this.quit(0);
    if (k.name === 'up' || k.char === 'k') { this._outputScroll = Math.max(0, this._outputScroll - 1); return this.render(); }
    if (k.name === 'down' || k.char === 'j') { this._outputScroll = this._outputScroll + 1; return this.render(); }
    this._outputScroll = 0;
    this.screen = this.prevScreen || 'browser';
    this.render();
  }

  // --------------------------------------------------------------- filter
  handleFilterKey(k) {
    if (k.name === 'ctrlc') return this.quit(0);
    if (k.name === 'escape' || k.char === 'q' || k.char === 'x') { this.screen = 'browser'; return this.render(); }
    if (k.name === 'up' || k.char === 'k') { this.fcursor = Math.max(0, this.fcursor - 1); return this.render(); }
    if (k.name === 'down' || k.char === 'j') { this.fcursor = Math.min(this.foptions.length - 1, this.fcursor + 1); return this.render(); }
    if (k.name === 'enter') return this.applyFilter(this.foptions[this.fcursor]);
    if (k.char && /[1-9]/.test(k.char)) { const i = Number(k.char) - 1; if (i < this.foptions.length) return this.applyFilter(this.foptions[i]); }
  }

  // -------------------------------------------------------------- actions
  refresh() {
    const { rows, total } = this.discovery.list({ limit: this.pageSize, offset: this.offset, filters: this.filters });
    this.rows = rows;
    this.total = total;
    if (rows.length === 0 && this.offset > 0) { this.offset = 0; }
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);
    // facet counts are two COUNT(*) queries — refresh them with the data, not
    // on every keystroke repaint
    try { this._facets = this.discovery.facetCounts(); } catch { /* keep last */ }
    this.log?.verbose(`refresh offset=${this.offset} rows=${rows.length} total=${total} filters=${JSON.stringify(this.filters)}`);
  }

  openMenu(row) {
    if (!row) return;
    this.selected = row;
    this.screen = 'menu';
    this._menuIdx = DEFAULT_MENU_IDX;
    this.render();
  }

  beginRename(s) {
    this.inputPrompt = `rename [${s.session_id.slice(0, 12)}…] new title:`;
    this.inputBuf = s.title ?? '';
    this.prevScreen = 'menu';
    this.screen = 'input';
    this.inputCb = v => {
      const title = v.trim();
      if (!title) { this.message = 'empty title — nothing changed'; this.messageKind = 'warn'; this.screen = 'menu'; return this.render(); }
      try {
        const r = this.lifecycle.rename(s.session_id, title);
        if (r.unchanged) { this.message = 'title unchanged'; this.messageKind = 'info'; }
        else { this.message = `renamed: "${r.before.title ?? '(none)'}" -> "${r.after.title}"`; this.messageKind = 'ok'; }
      } catch (e) { this.message = `rename failed: ${e.message}`; this.messageKind = 'warn'; }
      this.refresh(); this.screen = 'menu'; this.render();
    };
    this.render();
  }

  doArchive(s, on) {
    try {
      const r = this.lifecycle.setArchived(s.session_id, on);
      if (r.unchanged) { this.message = `already ${on ? 'archived' : 'unarchived'}`; this.messageKind = 'info'; }
      else { this.message = `${on ? 'archived' : 'unarchived'}: ${r.after.title ?? s.session_id}`; this.messageKind = 'ok'; }
    } catch (e) { this.message = `${on ? 'archive' : 'unarchive'} failed: ${e.message}`; this.messageKind = 'warn'; }
    this.refresh(); this.render();
  }

  async doFork(s) {
    this.message = 'forking via native runtime…'; this.messageKind = 'info'; this.render();
    try {
      const r = await this.lifecycle.fork(s.session_id, { cwd: s.workspace_dir });
      this.message = `forked -> ${r.newSessionId.slice(0, 16)}… (${trunc(r.session?.title, 30)})`;
      this.messageKind = 'ok';
    } catch (e) { this.message = `fork failed: ${e.message}`; this.messageKind = 'warn'; }
    this.refresh(); this.screen = 'browser'; this.render();
  }

  showInspect(s) {
    const d = this.inspector.inspect(s.session_id);
    const x = d.session;
    this.outputTitle = 'inspect';
    this.outputText = [
      `session: ${x.title ?? '(untitled)'}`,
      `id: ${x.session_id}`,
      `status: ${x.status}${x.archived ? ' (archived)' : ''}   visibility: ${x.visibility}   kind: ${x.session_kind}`,
      `runtime: ${x.runtime}   agent: ${x.agent_name}   type: ${x.session_type}`,
      `workspace: ${x.workspace_dir}${x.project_workspace_dir && x.project_workspace_dir !== x.workspace_dir ? '   project: ' + x.project_workspace_dir : ''}`,
      x.parent_session_id ? `parent: ${x.parent_session_id}   children: ${d.childSessionCount}` : `child sessions: ${d.childSessionCount}`,
      `created: ${iso(x.created_at_ms)}   updated: ${iso(x.updated_at_ms)}`,
      `messages: ${d.messageCount}   token rows: ${d.tokenUsage?.rows ?? 0}`,
      ...d.locks.map(l => `lock: ${l.owner_kind} acquired ${iso(l.acquired_at_ms)} expires ${iso(l.expires_at_ms)}`),
      ...(x.error_message ? [`error: ${x.error_message}`] : []),
    ].join('\n');
    this._outputScroll = 0;
    this.prevScreen = 'menu';
    this.screen = 'output';
    this.render();
  }

  showStats(s) {
    const st = this.inspector.stats(s.session_id);
    const u = st.tokenUsage || {};
    this.outputTitle = 'usage / stats';
    this.outputText = [
      `${st.title ?? st.sessionId}`,
      `messages: ${st.messageCount}  by role: ${(st.messagesByRole || []).map(r => `${r.role ?? 'none'}=${r.n}`).join(', ')}`,
      `turns: ${st.turnCount}   turn diffs: ${st.turnDiffCount}`,
      `tokens: in=${u.input ?? 0} out=${u.output ?? 0} reason=${u.reasoning ?? 0} cache_r=${u.cache_read ?? 0} cache_w=${u.cache_write ?? 0}`,
      `db rows belonging to session: ~${st.approxDbRows.total}`,
      `last activity: ${iso(st.lastActivityMs)}`,
    ].join('\n');
    this._outputScroll = 0;
    this.prevScreen = 'menu';
    this.screen = 'output';
    this.render();
  }

  showExport(s) {
    this.outputTitle = 'export (markdown preview; use `export --format json` for full data)';
    this.outputText = this.inspector.export(s.session_id, { format: 'markdown' });
    this._outputScroll = 0;
    this.prevScreen = 'menu';
    this.screen = 'output';
    this.render();
  }

  openResume(s) {
    if (!mcodeBinExists()) { this.message = `mcode binary not found (${MCODE_BIN})`; this.messageKind = 'warn'; return this.render(); }
    const args = ['--session', s.session_id];
    // mcode top-level has no --cwd; pass the workspace as the child's cwd
    this.pendingExec = { args, cwd: s.workspace_dir || undefined };
    this.message = `launching mcode ${args.join(' ')}${s.workspace_dir ? ` (cwd: ${s.workspace_dir})` : ''}`;
    this.render();
    this.quit(0);
  }

  // --------------------------------------------------------------- delete
  beginDelete(s) {
    // step 2: refuse automatically if the session is active/running
    const st = this.lifecycle.safety.activeState(s.session_id);
    if (st.active) {
      this.outputTitle = 'DELETE REFUSED — session is active';
      this.outputText = [
        `session: ${s.title ?? s.session_id}`,
        'the session is currently active/running, so the destructive',
        'operation was refused automatically.',
        '',
        ...st.reasons.map(r => `  - ${r}`),
        '',
        'stop or cancel the session first (let the turn finish, or close the',
        'owning process), then retry the delete.',
      ].join('\n');
      this._outputScroll = 0;
      this.prevScreen = 'menu';
      this.screen = 'output';
      return this.render();
    }
    // steps 4/5: dry-run plan, then explicit confirmation below
    const { entries, warnings } = this.lifecycle.safety.buildDeletePlan(s.session_id);
    const affecting = entries.filter(e => (e.count ?? 0) > 0);
    const rows = affecting.reduce((a, e) => a + e.count, 0);
    this.confirmToken = s.session_id.slice(-8);
    this.deleteTarget = s;
    this.deletePlan = { affecting, rows, warnings };
    this.inputBuf = '';
    this.prevScreen = 'menu';
    this.screen = 'confirm';
    this.render();
  }

  async executeDelete() {
    const s = this.deleteTarget;
    let report;
    try {
      report = await this.lifecycle.delete(s.session_id, { dryRun: false, confirm: true, noBackup: this.flags.noBackup });
    } catch (e) {
      report = { failed: true, error: e.message, backupPath: null };
    }
    const L = [];
    if (report.refused) L.push('DELETE REFUSED', report.reason, ...report.detail);
    else if (report.failed) L.push('DELETE FAILED', report.error, `backup: ${report.backupPath ?? 'none'}`, 'the transaction was rolled back; nothing was removed.');
    else {
      L.push(`deleted ${s.session_id}`,
        `backup: ${report.backupPath ?? '(disabled)'}`,
        `rows removed: ${report.rowsAffected} across ${report.tablesAffected} table(s)`,
        `verified: ${report.verified ? this.glyphs.ok + ' session and dependents gone' : 'WARNING: leftovers found'}`);
      for (const v of report.dependentCheck) if (v.remaining) L.push(`  leftover ${v.remaining} row(s) in ${v.table}`);
    }
    this.outputTitle = 'delete result';
    this.outputText = L.join('\n');
    this._outputScroll = 0;
    this.prevScreen = 'browser';
    this.screen = 'output';
    this.selected = null;
    this.refresh();
    this.render();
  }

  // ------------------------------------------------------------- render
  // Minimal in-place repaint. The previous frame is remembered and only the
  // lines that actually CHANGED are written, positioned with absolute cursor
  // addressing. Moving the cursor therefore emits ~2 lines (~0.5 KB) instead of
  // a full ~4.7 KB frame; that keeps every update well under the tty output
  // buffer (~4 KB) so the terminal can never paint a half-written frame — that
  // half-frame is what looked like the whole screen flashing and the header
  // briefly appearing over a stale body. One batched stdout write per frame,
  // \r\n line endings, no trailing newline, so the screen never scrolls.
  render() {
    const W = this.width;
    const g = this.glyphs;
    const line = g.h.repeat(W);
    let out;
    if (this.screen === 'browser') out = this.renderBrowser(W, line);
    else if (this.screen === 'search') out = this.renderSearch(W, line);
    else if (this.screen === 'menu') out = this.renderMenu(W, line);
    else if (this.screen === 'confirm') out = this.renderConfirm(W, line);
    else if (this.screen === 'input') out = this.renderInput(W, line);
    else if (this.screen === 'filter') out = this.renderFilter(W, line);
    else if (this.screen === 'output') out = this.renderOutput(W, line);
    else out = [''];

    // Hard guarantee: no line may exceed the terminal width. A single
    // soft-wrap desynchronises absolute cursor addressing and is what leaves
    // duplicate `›` cursors / stacked footers on screen.
    out = out.map(l => clipTo(l, W));
    while (out.length < this.height) out.push('');
    out = out.slice(0, this.height);

    const prev = this._prevLines;
    this._prevLines = out;
    // enter the alternate screen buffer + hide the cursor exactly once
    const pre = this._alt ? '' : (this._alt = true, '\x1b[?1049h\x1b[?25l');

    // first frame, after a resize, or after leaving the alt buffer: full paint
    if (!prev || prev.length !== out.length) {
      process.stdout.write('\x1b[H' + pre + out.map(l => l + '\x1b[K').join('\r\n') + '\x1b[J');
      return;
    }
    const changed = [];
    for (let i = 0; i < out.length; i++) if (out[i] !== prev[i]) changed.push(i);
    if (!changed.length) return; // identical frame: emit nothing at all
    // if most of the screen moved, a plain full repaint is cheaper than a long
    // run of cursor-move prefixes (and still lands as one batched write)
    if (changed.length > Math.max(4, out.length >> 1)) {
      process.stdout.write('\x1b[H' + pre + out.map(l => l + '\x1b[K').join('\r\n') + '\x1b[J');
      return;
    }
    let buf = '';
    for (const i of changed) buf += `\x1b[${i + 1};1H${out[i]}\x1b[K`;
    process.stdout.write(pre + buf);
  }

  // the "current/total" position, plus whether more rows exist off-screen
  positionInfo() {
    const cur = this.rows.length ? this.offset + this.cursor + 1 : 0;
    return { cur, total: this.total };
  }

  renderBrowser(W, line) {
    const g = this.glyphs;
    const f = this.filters;
    const fac = this._facets;
    const T = this.theme;
    const { cur, total } = this.positionInfo();
    const moreUp = this.offset > 0;
    const moreDown = this.offset + this.rows.length < total;
    const head = clipTo(
      T.style({ bold: true, fg: 'brand' }, ' mcode sessions')
      + '  ' + T.fg('muted', `n=${total}`)
      + '  ' + T.fg('warning', `arch=${fac.archived}`)
      + '  ' + T.fg('signal', `lock=${fac.active}`)
      + (moreUp || moreDown ? '  ' + T.fg('dim', `${moreUp ? g.up : ''}${moreDown ? g.down : ''}`) : ''),
      W,
    );
    // chrome: head + top rule + content(pageSize) + rule + pos + hint
    const rows = [head, T.fg('border', line)];
    const ps = this.pageSize;
    const start = this.offset + 1;
    const shown = this.rows.slice(0, ps);
    if (!shown.length) rows.push(T.fg('muted', clipTo('(no match — / search, x clear)', W)));
    for (let i = 0; i < shown.length; i++) rows.push(this.formatRow(shown[i], start + i, W, i === this.cursor));
    while (rows.length < 2 + ps) rows.push('');
    rows.push(T.fg('border', line));
    const fdesc = [
      f.archived === 'exclude' ? 'no-arch' : f.archived === 'only' ? 'arch' : '',
      f.q ? `q:${f.q}` : null, f.status ? f.status : null,
      f.kind ? f.kind : null, f.workspace ? shortWs(f.workspace) : null,
    ].filter(Boolean).join('  ');
    const pos = T.style({ bold: true, fg: 'signal' }, `${cur}/${total}`);
    const posLine = fdesc
      ? ` ${pos}  ${T.fg('muted', fdesc)}`
      : ` ${pos}`;
    rows.push(clipTo(posLine, W));
    rows.push(clipTo(this._hintLine(W), W));
    this.message = '';
    // hard guarantee: never emit more than the terminal height (footer first)
    if (rows.length > this.height) return rows.slice(rows.length - this.height);
    return rows;
  }

  // shared bottom hint; each tier's string is <= that tier's max width so
  // clipTo never has to cut a word. `msg` (when present) is prepended and the
  // combined result is still hard-clipped to W.
  _hintLine(W) {
    const T = this.theme;
    const W2 = W;
    // tiers: pick the longest hint whose length still fits W (minus room for
    // a one-shot message when one is pending)
    const msg = this.message ? this.colored(this.message, this.messageKind) + '  ' : '';
    const room = Math.max(8, W2 - (msg ? dispWidth(msg) : 0));
    const tiers = [
      [16, 'j/k  enter  /  q'],
      [30, 'j/k move  enter  /  x clear  q'],
      [45, 'j/k move  enter  /  n/b page  x clear  q quit'],
      [53, 'j/k move  enter  /  n/b page  a arch  x clear  q'],
      [68, 'j/k move  enter actions  / search  n/b page  a arch  x clear  q quit'],
      [74, 'j/k move  enter  / search  n/b page  a arch  s/t/w filter  x clear  q quit'],
      [82, 'j/k move  enter actions  / search  n/b page  a arch  s/t/w filter  x clear  q quit'],
      [93, 'j/k move  enter actions  / search  n/b page  a arch  s/t/w filter  x clear  r refresh  q quit'],
    ];
    let hint = tiers[0][1];
    for (const [len, h] of tiers) {
      if (len <= room) hint = h;
    }
    return clipTo(msg + T.fg('dim', hint), W2);
  }

  formatRow(r, n, W, sel) {
    const g = this.glyphs;
    const T = this.theme;
    const status = r.status ?? '?';
    const arch = r.archived ? ' arch' : '';
    const age = relAge(r.updated_at_ms);
    const kind = r.session_kind && r.session_kind !== 'conversation' ? ` <${r.session_kind[0]}>` : '';
    const ws = (!r.workspace_dir || r.workspace_dir === '/root') ? '' : ` @${shortWs(r.workspace_dir)}`;
    const num = String(n).padStart(W < 46 ? 2 : 3);

    if (W < 46) {
      const right = `${status}${arch}`;
      const leftBudget = Math.max(4, W - 1 - dispWidth(num) - 1 - dispWidth(right));
      const title = truncW(r.title ?? '(untitled)', leftBudget);
      const plain = clipTo(`${sel ? g.arrow : ' '}${num} ${title} ${right}`, W);
      if (sel) return T.style({ bg: 'selectedBg', fg: 'signal', bold: true }, padTo(plain, W));
      return clipTo([
        T.fg('dim', num), ' ', T.fg('text', title), ' ',
        T.fg(statusRole(status), status), T.fg('warning', arch),
      ].join(''), W);
    }

    // right column: status (padded) + optional arch + age — always aligned
    const rightPlain = `${status.padEnd(7)}${arch} ${age.padStart(4)}`;
    const fixed = 1 + dispWidth(num) + 2 + dispWidth(kind) + dispWidth(ws) + 2 + dispWidth(rightPlain);
    const title = truncW(r.title ?? '(untitled)', Math.max(3, Math.min(40, W - fixed)));
    const leftPlain = `${sel ? g.arrow : ' '}${num}  ${title}${kind}${ws}`;
    const plain = clipTo(fitLR(leftPlain, rightPlain, W), W);

    if (sel) {
      return T.style({ bg: 'selectedBg', fg: 'signal', bold: true }, padTo(plain, W));
    }
    // non-selected: colour left and right independently, fill the gap with spaces
    const lw = dispWidth(leftPlain);
    const rw = dispWidth(rightPlain);
    const gap = Math.max(1, W - lw - rw);
    return clipTo(
      T.fg('dim', `${sel ? g.arrow : ' '}${num}`) + '  '
      + T.fg('text', title) + T.fg('muted', kind) + T.fg('dim', ws)
      + ' '.repeat(gap)
      + T.fg(statusRole(status), status.padEnd(7))
      + T.fg('warning', arch) + ' '
      + T.fg('dim', age.padStart(4)),
      W,
    );
  }

  renderSearch(W, line) {
    const T = this.theme;
    const g = this.glyphs;
    const { rows, total, q } = this.searchResults;
    const promptW = Math.max(6, W - 16);
    const prompt = clipTo(T.style({ bold: true, fg: 'brand' }, ' search title: ')
      + T.style({ fg: 'text', bg: 'selectedBg' }, padTo(clipTo(this.searchBuf, promptW), promptW) + g.cursor), W);
    // chrome: prompt + rule + body + rule + footer = 5
    const H = this.height;
    const body = Math.max(0, H - 5);
    const out = [prompt, T.fg('border', line)];
    if (!rows.length && body > 0) out.push(T.fg('muted', clipTo(`(no sessions match "${q}")`, W)));
    for (let i = 0; i < Math.min(rows.length, body); i++) out.push(this.formatRow(rows[i], i + 1, W, false));
    while (out.length < Math.max(2, H - 2)) out.push('');
    out.length = Math.max(2, H - 2);
    out.push(T.fg('border', line));
    out.push(clipTo(
      ` ${T.style({ bold: true, fg: 'signal' }, String(total))} ${T.fg('muted', 'match(es)')}`
      + T.fg('dim', W < 60 ? '   enter ok  esc' : '   enter apply   esc cancel'),
      W,
    ));
    return out.slice(0, H);
  }

  renderMenu(W, line) {
    const s = this.selected;
    const T = this.theme;
    const x = s ? this.discovery.getSession(s.session_id) : null;
    if (!x) return [T.fg('muted', clipTo('(session gone — press q)', W))];
    const H = this.height;
    const hasMsg = !!this.message;
    // bottom chrome is fixed: rule + hint (+ optional message)
    const bottom = 2 + (hasMsg ? 1 : 0);
    // prefer full header (title/id/meta/rule) but shrink it on short terminals
    // so the action list + footer always stay visible
    let top = 4;
    if (H - top - bottom < 3) top = Math.max(1, H - bottom - 3);
    if (H - top - bottom < 1) top = Math.max(0, H - bottom);
    const avail = Math.max(1, H - top - bottom);

    const title = trunc(x.title ?? '(untitled)', Math.max(4, W - 2));
    const head = [];
    if (top >= 4) {
      head.push(
        clipTo(' ' + T.style({ bold: true, fg: 'brand' }, title), W),
        clipTo(` ${T.fg('muted', 'id')} ${T.fg('dim', x.session_id)}`, W),
        clipTo(
          ` ${T.fg(statusRole(x.status), x.status)}${x.archived ? T.fg('warning', ' arch') : ''}`
          + `  ${T.fg('muted', x.session_kind)}  ${T.fg('dim', shortWs(x.workspace_dir ?? ''))}`,
          W,
        ),
        T.fg('border', line),
      );
    } else if (top >= 3) {
      head.push(
        clipTo(' ' + T.style({ bold: true, fg: 'brand' }, title), W),
        clipTo(` ${T.fg('muted', 'id')} ${T.fg('dim', x.session_id)}`, W),
        T.fg('border', line),
      );
    } else if (top >= 2) {
      head.push(
        clipTo(' ' + T.style({ bold: true, fg: 'brand' }, title), W),
        T.fg('border', line),
      );
    } else if (top >= 1) {
      head.push(T.fg('border', line));
    }
    while (head.length < top) head.push('');
    head.length = top;

    // window the action list around the highlight so the footer never falls off
    const n = ACTION_MENU.length;
    let start = 0;
    let end = Math.min(n, avail);
    if (n > avail) {
      const room = Math.max(1, avail - 2);
      start = Math.max(0, Math.min(n - room, this._menuIdx - (room >> 1)));
      end = Math.min(n, start + room);
    }
    const menuRows = [];
    if (start > 0) menuRows.push(T.fg('dim', clipTo(`  ↑ +${start}`, W)));
    for (let i = start; i < end; i++) {
      const [key, label] = ACTION_MENU[i];
      const hl = i === this._menuIdx;
      const dangerous = key === '6';
      const plain = `${hl ? this.glyphs.arrow : ' '}${key}  ${label}`;
      if (hl) menuRows.push(T.style({ bg: 'selectedBg', fg: dangerous ? 'error' : 'signal', bold: true }, padTo(clipTo(plain, W), W)));
      else menuRows.push(clipTo(` ${T.fg('dim', key)}  ${dangerous ? T.fg('error', label) : T.fg('text', label)}`, W));
    }
    if (end < n) menuRows.push(T.fg('dim', clipTo(`  ↓ +${n - end}`, W)));
    while (menuRows.length < avail) menuRows.push('');
    menuRows.length = avail;

    const rows = [...head, ...menuRows, T.fg('border', line)];
    rows.push(clipTo(T.fg('dim', W < 44 ? ' esc  type number' : ' esc/q back   type the number or press enter'), W));
    if (hasMsg) rows.push(clipTo(this.colored(this.message, this.messageKind), W));
    this.message = '';
    if (rows.length > H) return rows.slice(rows.length - H); // keep footer
    return rows;
  }

  renderConfirm(W, line) {
    const T = this.theme;
    const s = this.deleteTarget, p = this.deletePlan;
    const H = this.height;
    // bottom is ALWAYS kept: rule + token + input + hint (the safety UI)
    const bottom = 4;
    // full top is 6 lines; shrink from the least-critical end on short screens
    const maxTop = 6;
    let top = maxTop;
    if (H - top - bottom < 1) top = Math.max(2, H - bottom - 1);
    if (H - top - bottom < 0) top = Math.max(1, H - bottom);
    const showRows = Math.max(0, H - top - bottom);

    const head = [];
    const title = T.style({ bold: true, fg: 'error' }, ' DELETE — destructive');
    const sessionLine = ` ${T.fg('muted', 'session')} ${T.fg('text', trunc(s.title ?? s.session_id, Math.max(4, W - 12)))}`;
    const idLine = ` ${T.fg('muted', 'id')} ${T.fg('dim', s.session_id)}`;
    const backupLine = ` ${T.fg('muted', 'backup')} ${this.flags.noBackup ? T.fg('error', 'DISABLED (--no-backup)') : T.fg('success', 'automatic')}`;
    const border = T.fg('border', line);
    const summary = ` ${T.fg('muted', 'tables')} ${T.fg('text', String(p.affecting.length))}   ${T.fg('muted', 'rows')} ${T.fg('text', String(p.rows))}`;
    // rebuild in visual order with progressive dropping
    if (top >= 6) head.push(title, sessionLine, idLine, backupLine, border, summary);
    else if (top >= 5) head.push(title, idLine, backupLine, border, summary);
    else if (top >= 4) head.push(title, idLine, border, summary);
    else if (top >= 3) head.push(title, idLine, border);
    else if (top >= 2) head.push(title, border);
    else if (top >= 1) head.push(title);
    while (head.length < top) head.push('');
    head.length = top;
    for (let i = 0; i < head.length; i++) head[i] = clipTo(head[i], W);

    const body = [];
    for (const e of p.affecting.slice(0, showRows)) {
      body.push(clipTo(`   ${T.fg('warning', String(e.count).padStart(6))}  ${T.fg('dim', e.table)}`, W));
    }
    if (showRows > 0 && p.affecting.length > showRows) {
      body.push(clipTo(`   ${T.fg('muted', `… +${p.affecting.length - showRows} more`)}`, W));
    }
    const room = Math.max(0, showRows - body.length);
    for (const w of p.warnings.slice(0, room)) {
      body.push(clipTo(`   ${T.fg('warning', 'warn: ' + w)}`, W));
    }
    while (body.length < showRows) body.push('');
    body.length = showRows;

    const rows = [
      ...head,
      ...body,
      T.fg('border', line),
      clipTo(T.style({ bold: true, fg: 'error' }, ` type last 8 of id  [${this.confirmToken}]`), W),
      clipTo(` > ${this.inputBuf}${this.glyphs.cursor}`, W),
      clipTo(T.fg('dim', W < 36 ? ' esc cancels' : ' esc/q cancels without any change'), W),
    ];
    // the safety footer (token + input) must survive even on a tiny screen
    if (rows.length > H) return rows.slice(rows.length - H);
    return rows;
  }

  renderInput(W, line) {
    const T = this.theme;
    return [
      clipTo(' ' + T.style({ bold: true, fg: 'brand' }, this.inputPrompt), W),
      T.fg('border', line),
      clipTo(` > ${T.style({ bg: 'selectedBg' }, padTo(this.inputBuf + this.glyphs.cursor, Math.max(4, W - 3)))}`, W),
      T.fg('border', line),
      clipTo(T.fg('dim', W < 36 ? ' enter  esc' : ' enter confirms   esc cancels'), W),
    ].slice(0, this.height);
  }

  renderFilter(W, line) {
    const T = this.theme;
    const H = this.height;
    const top = 2;
    const bottom = 2;
    const max = Math.max(1, H - top - bottom);
    const rows = [clipTo(' ' + T.style({ bold: true, fg: 'brand' }, `filter: ${this.filterKind}`), W), T.fg('border', line)];
    // window options around the cursor so the footer stays visible
    const n = this.foptions.length;
    let start = 0;
    if (n > max) start = Math.max(0, Math.min(n - max, this.fcursor - (max >> 1)));
    const end = Math.min(n, start + max);
    const body = [];
    if (start > 0) body.push(T.fg('dim', clipTo(`  ↑ +${start}`, W)));
    for (let i = start; i < end; i++) {
      const o = this.foptions[i];
      const hl = this.fcursor === i;
      const label = clipTo(trunc(o.label, Math.max(4, W - 8)), Math.max(4, W - 6));
      const plain = `${hl ? this.glyphs.arrow : ' '}${i + 1}  ${label}`;
      if (hl) body.push(T.style({ bg: 'selectedBg', fg: 'signal', bold: true }, padTo(plain, W)));
      else body.push(clipTo(` ${T.fg('dim', String(i + 1))}  ${T.fg('text', label)}`, W));
    }
    if (end < n) body.push(T.fg('dim', clipTo(`  ↓ +${n - end}`, W)));
    while (body.length < max) body.push('');
    body.length = max;
    rows.push(...body, T.fg('border', line));
    rows.push(clipTo(T.fg('dim', W < 44 ? ' j/k  enter  esc' : ' j/k or number   enter selects   esc/x clears'), W));
    if (rows.length > H) return rows.slice(rows.length - H);
    return rows;
  }

  renderOutput(W, line) {
    const T = this.theme;
    const L = this.outputText.split('\n');
    // top: title, rule = 2; bottom: rule, hint = 2
    const max = Math.max(1, this.height - 4);
    const start = Math.min(Math.max(0, this._outputScroll), Math.max(0, L.length - max));
    const shown = L.slice(start, start + max);
    const moreAfter = L.length - start - shown.length;
    const moreBefore = start;
    const scrollNote = (moreBefore || moreAfter)
      ? T.fg('dim', `  ${moreBefore ? '↑' : ''}${moreBefore && moreAfter ? ' ' : ''}${moreAfter ? `+${moreAfter}` : ''} j/k`)
      : '';
    return [
      clipTo(' ' + T.style({ bold: true, fg: 'brand' }, this.outputTitle) + scrollNote, W),
      T.fg('border', line),
      ...shown.map(l => clipTo(l, W)),
      ...Array.from({ length: Math.max(0, max - shown.length) }, () => ''),
      T.fg('border', line),
      clipTo(T.fg('dim', W < 40 ? ' j/k scroll  esc' : ' j/k scroll   any other key goes back'), W),
    ];
    if (rows.length > this.height) return rows.slice(rows.length - this.height);
    return rows;
  }

  // -------------------------------------------------------------- utils
  // message kinds map onto mcode's semantic colours
  colored(text, kind) {
    const role = kind === 'danger' ? 'error' : kind === 'warn' ? 'warning' : kind === 'ok' ? 'success' : 'signal';
    return this.theme.style({ bold: kind !== 'info', fg: role }, text);
  }
}

// ----------------------------------------------------------------- utils
// truncate to a *display width* (titles may contain wide characters)
function truncW(s, n) {
  s = String(s ?? '');
  if (dispWidth(s) <= n) return s;
  let out = '';
  for (const ch of s) {
    if (dispWidth(out + ch) > n - 1) break;
    out += ch;
  }
  return out + '…';
}
const trunc = truncShared; // same helper as the CLI (shared with format.js)
export { trunc };

// minimal key decoder: input chunk -> [{name, char}]
// name is one of: up down left right home end pgup pgdn enter escape
// backspace tab space ctrlc, or 'char' (with the printable char) for letters.
export function decodeKeys(chunk) {
  const out = [];
  const s = String(chunk);
  let i = 0;
  while (i < s.length) {
    const c = s[i++];
    if (c === '\x03') { out.push({ name: 'ctrlc' }); continue; }
    if (c === '\x1b') {
      if (i < s.length && s[i] === '[') {
        i++;
        let spec = '';
        while (i < s.length && /[0-9;?]/.test(s[i])) spec += s[i++];
        const fin = i < s.length ? s[i++] : '';
        out.push({ name: arrowName(spec, fin) });
        continue;
      }
      if (i < s.length && s[i] === 'O') { i++; const f2 = i < s.length ? s[i++] : ''; out.push({ name: arrowName('', f2) }); continue; }
      out.push({ name: 'escape' });
      continue;
    }
    if (c === '\r' || c === '\n') { out.push({ name: 'enter' }); continue; }
    if (c === '\x7f' || c === '\b') { out.push({ name: 'backspace' }); continue; }
    if (c === '\t') { out.push({ name: 'tab' }); continue; }
    if (c === ' ') { out.push({ name: 'space', char: ' ' }); continue; }
    if (c >= ' ' && c <= '~') { out.push({ name: 'char', char: c }); continue; }
  }
  return out;
}
function arrowName(spec, fin) {
  if (fin === 'A') return 'up';
  if (fin === 'B') return 'down';
  if (fin === 'C') return 'right';
  if (fin === 'D') return 'left';
  if (fin === 'H' || fin === '1') return 'home';
  if (fin === 'F' || fin === '4') return 'end';
  if (fin === '~') return spec === '5' ? 'pgup' : spec === '6' ? 'pgdn' : 'escape';
  return 'escape';
}
