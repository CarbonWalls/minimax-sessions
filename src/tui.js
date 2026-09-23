// Small-screen-friendly terminal UI. No mouse, no framework; raw stdin + ANSI.
// Degrades to plain ASCII with --ascii and to number+title+status on narrow
// terminals. Handles resize (SIGWINCH) and Ctrl-C cleanly.
import { spawn } from 'node:child_process';
import { Discovery } from './discovery.js';
import { Lifecycle } from './lifecycle.js';
import { Inspector } from './inspect.js';
import { SqliteAdapter } from './sqlite.js';
import { MCODE_BIN, dbExists, mcodeBinExists } from './env.js';

const GLYPHS_ASCII = { h: '-', v: '|', arrow: '>', ok: 'ok', warn: '!' };
const GLYPHS_UNICODE = { h: '─', v: '│', arrow: '›', ok: '✓', warn: '⚠' };

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
    this.color = flags.color && process.env.NO_COLOR == null;
    this.glyphs = flags.ascii ? GLYPHS_ASCII : GLYPHS_UNICODE;
    this.db = new SqliteAdapter({ log });
    this.discovery = new Discovery({ log, db: this.db });
    this.lifecycle = new Lifecycle({ log, db: this.db });
    this.inspector = new Inspector({ log, db: this.db });

    this.screen = 'browser';
    this.cursor = 0;
    this.page = 0;
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
    this._sigwinch = () => { this.cursor = 0; this.render(); };
    process.on('SIGWINCH', this._sigwinch);

    this.refresh();
    this.render();
    stdin.on('data', d => this.onKey(d));
    return new Promise(resolve => { this._resolve = resolve; });
  }

  quit(code) {
    if (this._restore) this._restore();
    try { process.stdin.removeAllListeners('data'); process.stdin.pause(); } catch {}
    process.stdout.write('\x1b[2J\x1b[H');
    if (this.pendingExec) {
      const { args } = this.pendingExec;
      process.stdout.write(`launching: mcode ${args.join(' ')}\n`);
      try {
        const child = spawn(MCODE_BIN, args, { stdio: 'inherit' });
        child.on('exit', c => this._done(c ?? 0));
        child.on('error', () => this._done(code));
        return;
      } catch { this._done(code); return; }
    }
    this._done(code);
  }
  _done(code) { if (this._resolve) { const r = this._resolve; this._resolve = null; r(code); } }
  destroy() { try { this.db.close(); } catch {} }

  get width() { return Math.max(20, process.stdout.columns || 80); }
  get height() { return Math.max(8, process.stdout.rows || 24); }
  get pageSize() { return Math.max(3, this.height - 8); }

  onKey(chunk) {
    for (const k of decodeKeys(chunk)) {
      if (this.screen === 'input') this.handleInputKey(k);
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
    if (k.char === 'q' || k.name === 'escape') return this.quit(0);
    if (k.name === 'up' || k.char === 'k') { this.cursor = Math.max(0, this.cursor - 1); return this.render(); }
    if (k.name === 'down' || k.char === 'j') { this.cursor = Math.min(n - 1, this.cursor + 1); return this.render(); }
    if (k.name === 'home' || k.char === 'g') { this.cursor = 0; return this.render(); }
    if (k.name === 'end' || k.char === 'G') { this.cursor = n - 1; return this.render(); }
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
    const { rows, total } = this.discovery.list({ limit: this.pageSize, offset: this.page * this.pageSize, filters: this.filters });
    this.rows = rows;
    this.total = total;
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);
    this.log?.verbose(`refresh page=${this.page} rows=${rows.length} total=${total} filters=${JSON.stringify(this.filters)}`);
  }
  nextPage() { if ((this.page + 1) * this.pageSize < this.total) { this.page++; this.cursor = 0; this.refresh(); } this.render(); }
  prevPage() { if (this.page > 0) { this.page--; this.cursor = 0; this.refresh(); } this.render(); }

  cycleArchived() {
    const order = ['include', 'exclude', 'only'];
    this.filters.archived = order[(order.indexOf(this.filters.archived ?? 'include') + 1) % 3];
    this.page = 0; this.cursor = 0; this.refresh(); this.render();
  }
  clearFilters() { this.filters = { archived: 'include' }; this.page = 0; this.cursor = 0; this.refresh(); this.message = 'filters cleared'; this.render(); }

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
    this.page = 0; this.cursor = 0; this.refresh();
    this.screen = 'browser';
    this.render();
  }

  beginSearch() {
    this.inputPrompt = 'search title:';
    this.inputBuf = this.filters.q ?? '';
    this.prevScreen = 'browser';
    this.screen = 'input';
    this.inputCb = v => {
      if (v.trim()) this.filters.q = v.trim(); else delete this.filters.q;
      this.page = 0; this.cursor = 0; this.refresh();
      this.screen = 'browser'; this.render();
    };
    this.render();
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
    this.prevScreen = 'menu';
    this.screen = 'output';
    this.render();
  }

  showExport(s) {
    this.outputTitle = 'export (markdown preview; use `export --format json` for full data)';
    this.outputText = this.inspector.export(s.session_id, { format: 'markdown' });
    this.prevScreen = 'menu';
    this.screen = 'output';
    this.render();
  }

  openResume(s) {
    if (!mcodeBinExists()) { this.message = `mcode binary not found (${MCODE_BIN})`; this.messageKind = 'warn'; return this.render(); }
    const args = ['--session', s.session_id];
    if (s.workspace_dir) args.push('--cwd', s.workspace_dir);
    this.pendingExec = { args };
    this.message = `launching mcode ${args.join(' ')}`;
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
    this.prevScreen = 'browser';
    this.screen = 'output';
    this.selected = null;
    this.refresh();
    this.render();
  }

  // ------------------------------------------------------------- render
  render() {
    const out = [];
    const W = this.width;
    const g = this.glyphs;
    const line = g.h.repeat(Math.max(4, Math.min(W, 72)));
    if (this.screen === 'browser') out.push(...this.renderBrowser(W, line));
    else if (this.screen === 'menu') out.push(...this.renderMenu(W, line));
    else if (this.screen === 'confirm') out.push(...this.renderConfirm(W, line));
    else if (this.screen === 'input') out.push(...this.renderInput(W, line));
    else if (this.screen === 'filter') out.push(...this.renderFilter(W, line));
    else if (this.screen === 'output') out.push(...this.renderOutput(W, line));

    while (out.length < this.height) out.push('');
    const body = out.slice(0, this.height).join('\n');
    process.stdout.write('\x1b[H' + (this.color ? '\x1b[2J' : '') + body + '\n');
  }

  renderBrowser(W, line) {
    const f = this.filters;
    const fac = this.discovery.facetCounts();
    const rows = [
      ` mcode sessions  n=${this.total}  archived=${fac.archived}  locked=${fac.active}`,
      line,
    ];
    const start = this.page * this.pageSize + 1;
    if (!this.rows.length) rows.push('(no sessions match — / search, x clear filters)');
    for (let i = 0; i < this.rows.length; i++) rows.push(this.formatRow(this.rows[i], start + i, W, i === this.cursor));
    rows.push(line);
    const fdesc = [
      f.archived === 'exclude' ? 'no-arch' : f.archived === 'only' ? 'arch-only' : 'arch-in',
      f.q ? `q:"${f.q}"` : null, f.status ? `status=${f.status}` : null,
      f.kind ? `kind=${f.kind}` : null, f.workspace ? `ws=${shortWs(f.workspace)}` : null,
    ].filter(Boolean).join(' ');
    const pageTxt = this.total > this.pageSize ? `page ${this.page + 1}/${Math.max(1, Math.ceil(this.total / this.pageSize))}  ` : '';
    rows.push(pageTxt + fdesc);
    const hint = W < 46
      ? 'num/enter open  j/k move  q quit  / search  r refresh'
      : 'j/k move  enter actions  / search  n/b page  a arch  s/t/w filter  x clear  r refresh  q quit';
    rows.push((this.message ? this.colored(this.message, this.messageKind) + '  ' : '') + hint);
    this.message = '';
    return rows;
  }

  formatRow(r, n, W, sel) {
    const marker = sel ? this.glyphs.arrow : ' ';
    const arch = r.archived ? ' [arch]' : '';
    const kind = r.session_kind && r.session_kind !== 'conversation' ? ` <${r.session_kind[0]}>` : '';
    const age = relAge(r.updated_at_ms);
    const ws = (!r.workspace_dir || r.workspace_dir === '/root') ? '' : ` @${shortWs(r.workspace_dir)}`;
    if (W < 46) {
      const title = trunc(r.title ?? '(untitled)', Math.max(6, W - 15));
      return `${marker}${String(n).padStart(2)} ${title} ${r.status}${arch}`.slice(0, W);
    }
    const titleMax = Math.max(10, Math.min(38, W - 36));
    const title = trunc(r.title ?? '(untitled)', titleMax);
    const st = r.status === 'started' ? this.colored(r.status ?? '?', 'active') : (r.status ?? '?');
    let s = `${marker}${String(n).padStart(3)}  ${title}${kind}${ws}  ${st}${arch}  ${age}`;
    return s.length > W ? s.slice(0, W) : s;
  }

  renderMenu(W, line) {
    const s = this.selected;
    const x = s ? this.discovery.getSession(s.session_id) : null;
    if (!x) return ['(session gone — press q)'];
    const rows = [
      ` session: ${trunc(x.title ?? '(untitled)', Math.max(10, W - 12))}`,
      ` id: ${x.session_id}`,
      ` status: ${x.status}${x.archived ? ' (archived)' : ''}   kind: ${x.session_kind}   ws: ${shortWs(x.workspace_dir ?? '')}`,
      line,
    ];
    for (let i = 0; i < ACTION_MENU.length; i++) {
      const [key, label] = ACTION_MENU[i];
      const hl = i === this._menuIdx;
      const dangerous = key === '6';
      rows.push(`${hl ? this.glyphs.arrow + ' ' : '  '}${key}  ${dangerous ? this.colored(label, 'danger') : label}`);
    }
    rows.push(line);
    rows.push('esc/q/backspace back   type the number or press enter');
    if (this.message) rows.push(this.colored(this.message, this.messageKind));
    this.message = '';
    return rows;
  }

  renderConfirm(W, line) {
    const s = this.deleteTarget, p = this.deletePlan;
    const showRows = Math.max(4, this.height - 16);
    const rows = [
      this.colored(' DELETE — destructive', 'danger'),
      ` session: ${trunc(s.title ?? s.session_id, Math.max(10, W - 12))}`,
      ` id: ${s.session_id}`,
      ` backup: ${this.flags.noBackup ? 'DISABLED (--no-backup)' : 'automatic (path shown after)'}`,
      line,
      ` tables affected: ${p.affecting.length}   rows: ${p.rows}`,
    ];
    for (const e of p.affecting.slice(0, showRows)) rows.push(`   ${String(e.count).padStart(6)}  ${e.table}`);
    if (p.affecting.length > showRows) rows.push(`   ... +${p.affecting.length - showRows} more table(s)`);
    for (const w of p.warnings) rows.push(`   warn: ${w}`);
    rows.push(line);
    rows.push(this.colored(` type the last 8 chars of the id to confirm: [${this.confirmToken}]`, 'danger'));
    rows.push(` > ${this.inputBuf}`);
    rows.push(' esc/q cancels without any change');
    return rows;
  }

  renderInput(W, line) {
    return [
      ` ${this.inputPrompt}`,
      line,
      ` > ${this.inputBuf}`,
      line,
      ' enter confirms   esc cancels',
    ];
  }

  renderFilter(W, line) {
    const rows = [` filter: ${this.filterKind}`, line];
    const max = Math.min(this.foptions.length, this.height - 6);
    for (let i = 0; i < max; i++) {
      const o = this.foptions[i];
      rows.push(`${(this.fcursor === i ? this.glyphs.arrow : ' ')}${i + 1}  ${trunc(o.label, Math.max(8, W - 8))}`);
    }
    rows.push(line);
    rows.push(' j/k or number   enter selects   esc/x clears');
    return rows;
  }

  renderOutput(W, line) {
    const L = this.outputText.split('\n');
    const max = Math.max(3, this.height - 5);
    const shown = L.slice(0, max);
    return [
      ` ${this.outputTitle}${L.length > max ? `  (${L.length - max} more lines)` : ''}`,
      line,
      ...shown.map(l => trunc(l, W)),
      line,
      ' press any key to go back',
    ];
  }

  // -------------------------------------------------------------- utils
  colored(text, kind) {
    if (!this.color) return text;
    const C = { danger: '\x1b[31m', warn: '\x1b[33m', ok: '\x1b[32m', active: '\x1b[36m' };
    return (C[kind] || '') + text + '\x1b[0m';
  }
}

// ----------------------------------------------------------------- utils
export function trunc(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s; }
function shortWs(w) { if (!w) return ''; const p = String(w).split('/'); return p[p.length - 1] || w; }
function relAge(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.round(s / 86400 / 30)}mo`;
  return `${Math.round(s / 86400 / 365)}y`;
}
function iso(ms) { if (ms == null) return '?'; try { return new Date(Number(ms)).toISOString(); } catch { return '?'; } }

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
