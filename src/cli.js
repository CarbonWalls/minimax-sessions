// CLI (non-interactive) command surface.
import { writeFileSync, existsSync, mkdirSync, statSync, accessSync, constants as FS } from 'node:fs';
import { spawn } from 'node:child_process';
import { Logger } from './log.js';
import { SqliteAdapter } from './sqlite.js';
import { Discovery } from './discovery.js';
import { Lifecycle } from './lifecycle.js';
import { Inspector, EXPORT_FORMATS } from './inspect.js';
import { Safety } from './safety.js';
import { trunc, shortWs, relAge, iso, wrapText, clipTo, fitLR, dispWidth } from './format.js';
import {
  DB_PATH, MSM_DIR, MSM_LOG_DIR, MSM_BACKUP_DIR, dbExists, mcodeBinExists,
  mcodeVersion, MCODE_BIN, MCODE_INSTALL_ROOT, MCODE_PKG, MCODE_RELEASE,
  SESSION_ID_PREFIX, parseFlags,
} from './env.js';

const VERSION = '1.1.0';

const HELP = `mcode-sessions — MiniMax Code session manager

usage:
  mcode-sessions                       interactive TUI (default, no args)
  mcode-sessions list [text]           list sessions
  mcode-sessions search <text>         search title/purpose/id
                                       (--messages also hits bodies)
  mcode-sessions inspect <id>          show compact metadata
  mcode-sessions rename <id> <title>   rename a session
  mcode-sessions archive <id>          archive a session
  mcode-sessions unarchive <id>        unarchive a session
  mcode-sessions fork <id> [--cwd DIR] fork via the native runtime
  mcode-sessions delete <id>           dry-run by default; --confirm runs
  mcode-sessions export <id>           --format markdown|json|jsonl|metadata
  mcode-sessions stats <id>            usage / statistics
  mcode-sessions active <id>           report whether a session is running
  mcode-sessions plan <id>             dry-run deletion plan
  mcode-sessions resume <id>           launch mcode attached to a session
  mcode-sessions doctor                env / schema / native runtime check

filters:
  --archived / --no-archived / --only-archived
  --status <s>   --kind <k>   --workspace <dir>   --parent <id>

safety:
  --dry-run              show what would happen; change nothing
  --confirm              required to apply destructive operations
  --no-backup            skip the automatic pre-delete database backup
  --session <id>         select a session by exact id (scripting)

output / logging:
  --json                 machine-readable output
  --limit <n> / --offset <n>   page list results (default limit 200)
  --out <file>           write export output to a file
  --format <fmt>         export format: ${EXPORT_FORMATS.join(' | ')}
  --ascii                plain-ASCII UI (no box-drawing)
  --no-color             disable colour
  --debug / --verbose    more detail in the msm.log file

env overrides:
  MSM_RUNTIME_DATA_DIR   MiniMax runtime data dir
  MSM_HOME               this tool's state dir
  MSM_MCODE_ROOT         mcode install root
  MSM_MCODE_RELEASE      pin a release (else newest is auto-found)
  MSM_BACKUP_KEEP        backups to keep (default 20)
  MSM_THEME              light|dark override
  MSM_THEME_NAME         theme name override
`;

export async function runCli(argv) {
  const { flags, positional } = parseFlags(argv);
  const log = new Logger({ level: flags.debug ? 'debug' : (flags.verbose ? 'verbose' : 'info') });
  log.verbose(`cli start: positional=${JSON.stringify(positional)}`);
  if (flags.unknown?.length) log.warn(`unknown flag(s) ignored: ${flags.unknown.join(' ')}`);

  if (flags.help || positional[0] === 'help') {
    if (!flags.json) process.stdout.write(wrapText(HELP, termWidth()) + '\n');
    return 0;
  }
  if (flags.version) { print(`mcode-sessions ${VERSION} (mcode ${mcodeVersion()}, release ${MCODE_RELEASE})`, flags); return 0; }

  const cmd = positional[0] ?? '';
  if (!cmd) {
    const { runTui } = await import('./tui.js');
    return runTui({ flags, log });
  }

  // doctor works even when the DB is missing (it reports that as a finding)
  if (cmd === 'doctor') return cmdDoctor(flags, log);

  if (!dbExists()) {
    stderr(`runtime database not found: ${DB_PATH}`);
    stderr('set MSM_RUNTIME_DATA_DIR to override the data dir, or check your installation.');
    stderr('run `mcode-sessions doctor` for a full environment check.');
    return 2;
  }

  const db = new SqliteAdapter({ log });
  try {
    switch (cmd) {
      case 'list':       return cmdList(positional.slice(1), flags, db, log);
      case 'search':     return cmdSearch(positional.slice(1), flags, db, log);
      case 'inspect':    return cmdInspect(positional, flags, db, log);
      case 'rename':     return await cmdRename(positional, flags, db, log);
      case 'archive':    return await cmdArchive(positional, flags, db, log, true);
      case 'unarchive':  return await cmdArchive(positional, flags, db, log, false);
      case 'fork':       return await cmdFork(positional, flags, db, log);
      case 'delete':     return await cmdDelete(positional, flags, db, log);
      case 'export':     return cmdExport(positional, flags, db, log);
      case 'stats':      return cmdStats(positional, flags, db, log);
      case 'active':     return cmdActive(positional, flags, db, log);
      case 'plan':       return cmdPlan(positional, flags, db, log);
      case 'resume':
      case 'open':       return await cmdResume(positional, flags, db, log);
      default:
        stderr(`unknown command: ${cmd}\n\n${wrapText(HELP, termWidth())}`);
        return 2;
    }
  } catch (e) {
    log.error(`command '${cmd}' failed: ${e.message}`);
    stderr(`error: ${e.message}`);
    return 1;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- helpers
function termWidth() {
  // TTY width first; COLUMNS as a fallback for pipes/CI; never below 20.
  const env = Number(process.env.COLUMNS);
  return Math.max(20, process.stdout.columns || (Number.isFinite(env) && env > 0 ? env : 80));
}
function print(s, flags) {
  if (flags?.json) return;
  // never let a human-facing line soft-wrap mid-word on a narrow terminal
  process.stdout.write(wrapText(String(s), termWidth()) + '\n');
}
function stderr(s) { process.stderr.write(wrapText(String(s), termWidth()) + '\n'); }
function out(flags, obj, human) {
  if (flags.json) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); return; }
  if (human) human();
}

function resolveId(positional, flags) {
  const id = String((flags.session || positional[1]) ?? '').trim();
  if (!id) throw new Error('no session id given (use an exact mvs_ id or --session <id>)');
  return id;
}
function assertExactId(id) {
  if (!id.startsWith(SESSION_ID_PREFIX))
    throw new Error(`expected an exact ${SESSION_ID_PREFIX}... session id (never a title)`);
}
function filtersFrom(flags, args) {
  const f = {};
  if (flags.status) f.status = flags.status;
  if (flags.kind) f.kind = flags.kind;
  if (flags.workspace) f.workspace = flags.workspace;
  if (flags.onlyArchived) f.archived = 'only';
  else if (flags.includeArchived === false) f.archived = 'exclude';
  if (flags.parent) f.parent = flags.parent;
  if (args?.[0] && !String(args[0]).startsWith('-')) f.q = args[0];
  return f;
}
function listLimit(flags, dflt = 200) {
  return Number.isFinite(flags.limit) && flags.limit > 0 ? flags.limit : dflt;
}

function cmdList(args, flags, db, log) {
  const d = new Discovery({ log, db });
  const filters = filtersFrom(flags, args);
  const limit = listLimit(flags);
  const offset = Number.isFinite(flags.offset) && flags.offset > 0 ? flags.offset : 0;
  const { rows, total } = d.list({ limit, offset, filters });
  if (flags.json) { process.stdout.write(JSON.stringify({ total, limit, offset, sessions: rows }, null, 2) + '\n'); return 0; }
  const fac = d.facetCounts();
  print(`mcode sessions  (mcode ${mcodeVersion()})  total=${total} archived=${fac.archived} locked=${fac.active}`, flags);
  print('-'.repeat(Math.min(cols(), 60)), flags);
  if (!rows.length) { print('(no sessions match)', flags); return 0; }
  rows.forEach((r, i) => print(formatRow(r, offset + i + 1, cols()), flags));
  if (offset + rows.length < total) print(`… ${total - offset - rows.length} more (use --limit/--offset)`, flags);
  return 0;
}

function cmdSearch(args, flags, db, log) {
  const q = args[0];
  if (!q) throw new Error('search requires a text argument');
  const d = new Discovery({ log, db });
  const filters = filtersFrom(flags, null);
  filters.q = q;
  const limit = listLimit(flags);
  const { rows, total } = d.list({ limit, filters });
  let extra = null;
  if (flags.messages) {
    const ids = new Set(d.searchMessages(q, { limit: 1000 }));
    // top up the title search with message-body hits
    for (const id of ids) {
      if (rows.some(r => r.session_id === id)) continue;
      const s = d.getSession(id);
      if (s && !filtersFromMatches(filters, s)) continue;
      if (rows.length < limit) rows.push(s);
    }
    extra = ids.size;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({ query: q, total, messageHits: extra, sessions: rows }, null, 2) + '\n');
    return 0;
  }
  print(`search "${q}" — ${total} title match(es)${extra != null ? `, ${extra} message-body hit(s)` : ''}`, flags);
  rows.forEach((r, i) => print(formatRow(r, i + 1, cols()), flags));
  return 0;
}

function filtersFromMatches(filters, s) {
  if (filters.archived === 'only' && !s.archived) return false;
  if (filters.archived === 'exclude' && s.archived) return false;
  if (filters.status && s.status !== filters.status) return false;
  if (filters.kind && s.session_kind !== filters.kind) return false;
  if (filters.workspace && s.workspace_dir !== filters.workspace) return false;
  return true;
}

function cmdInspect(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const data = new Inspector({ log, db }).inspect(id);
  out(flags, data, () => {
    const s = data.session;
    print(`session: ${s.title ?? '(untitled)'}`);
    print(`id: ${s.session_id}`);
    print(`status: ${s.status}${s.archived ? ' (archived)' : ''}   visibility: ${s.visibility}   kind: ${s.session_kind}`);
    print(`runtime: ${s.runtime}   agent: ${s.agent_name}   type: ${s.session_type}`);
    print(`workspace: ${s.workspace_dir}${s.project_workspace_dir && s.project_workspace_dir !== s.workspace_dir ? ' (project: ' + s.project_workspace_dir + ')' : ''}`);
    if (s.parent_session_id) print(`parent: ${s.parent_session_id}   children: ${data.childSessionCount}`);
    else print(`child sessions: ${data.childSessionCount}`);
    print(`created: ${iso(s.created_at_ms)}   updated: ${iso(s.updated_at_ms)}`);
    print(`messages: ${data.messageCount}   token rows: ${data.tokenUsage?.rows ?? 0}`);
    if (data.locks.length) print(`locks: ${data.locks.map(l => `${l.owner_kind} exp ${iso(l.expires_at_ms)}`).join(', ')}`);
    if (s.error_message) print(`error: ${s.error_message}`);
  });
  return 0;
}

async function cmdRename(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const title = positional[2];
  if (!title) throw new Error('rename requires a new title argument');
  const before = new Discovery({ log, db }).getSession(id);
  if (!flags.confirm && !flags.nonInteractive) {
    print(`rename "${before.title ?? '(untitled)'}" -> "${title}"`, flags);
    print(`re-run with --confirm to apply (id ${id})`, flags);
    return 0;
  }
  const r = new Lifecycle({ log, db }).rename(id, title);
  out(flags, r, () => {
    if (r.unchanged) { print('title unchanged'); return; }
    print(`renamed: "${r.before.title ?? '(untitled)'}" -> "${r.after.title}"`);
  });
  return 0;
}

async function cmdArchive(positional, flags, db, log, on) {
  const id = resolveId(positional, flags); assertExactId(id);
  if (!flags.confirm && !flags.nonInteractive) {
    print(`${on ? 'archive' : 'unarchive'} ${id} — re-run with --confirm to apply`, flags);
    return 0;
  }
  const r = new Lifecycle({ log, db }).setArchived(id, on);
  out(flags, r, () => {
    if (r.unchanged) { print(`already ${on ? 'archived' : 'not archived'}`); return; }
    print(`${on ? 'archived' : 'unarchived'}: ${id} (archived=${r.after.archived})`);
  });
  return 0;
}

async function cmdFork(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const cwd = flags.cwd ?? undefined;
  if (!mcodeBinExists()) throw new Error(`mcode binary not found (${MCODE_BIN}); native fork unavailable`);
  const r = await new Lifecycle({ log, db }).fork(id, { cwd });
  out(flags, r, () => {
    print(`forked ${id} -> ${r.newSessionId}`);
    print(`title: ${r.session?.title ?? '(none)'}  workspace: ${r.session?.workspace_dir}`);
  });
  return 0;
}

async function cmdDelete(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const report = await new Lifecycle({ log, db }).delete(id, {
    dryRun: flags.dryRun || !flags.confirm,
    confirm: flags.confirm && !flags.dryRun,
    noBackup: flags.noBackup,
  });

  // one authoritative exit code for both human and --json output
  let exit;
  if (report.refused) exit = 3;
  else if (report.failed) exit = 1;
  else if (report.cancelled) exit = 0;
  else if (report.needsConfirm) exit = 4;
  else if (report.dryRun) exit = 0;
  else exit = report.verified ? 0 : 5;

  if (flags.json) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return exit; }

  if (report.refused) {
    stderr(`REFUSED: ${report.reason}`);
    for (const r of report.detail) stderr(`  - ${r}`);
    stderr('stop/cancel the session first (let the turn finish or close the owning process), then retry.');
    return exit;
  }
  if (report.dryRun) {
    print(`DRY RUN — delete ${id}`, flags);
    print(`tables affected: ${report.tablesAffected}   rows: ${report.rowsAffected}`, flags);
    for (const e of report.entries) print(`  ${String(e.count).padStart(6)}  ${e.table}  [${e.kind}]`, flags);
    for (const w of report.warnings) print(`  warn: ${w}`, flags);
    print('nothing was changed. Re-run with --confirm to execute.', flags);
    return exit;
  }
  if (report.failed) { stderr(`delete FAILED — ${report.error}`); stderr(`backup: ${report.backupPath}`); return exit; }
  if (report.cancelled) { print('cancelled — nothing was changed', flags); return exit; }
  if (report.needsConfirm) { print('confirmation required: pass --confirm (or --dry-run to preview)', flags); return exit; }
  print(`deleted ${id}`, flags);
  print(`backup: ${report.backupPath ?? '(disabled with --no-backup)'}`, flags);
  print(`rows removed: ${report.rowsAffected} across ${report.tablesAffected} table(s)`, flags);
  print(`verified: ${report.verified ? 'OK — session and dependents gone' : 'WARNING — verification found leftovers:'}`, flags);
  for (const v of report.dependentCheck) if (v.remaining) print(`  leftover ${v.remaining} row(s) in ${v.table}`, flags);
  return exit;
}

function cmdExport(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const format = flags.format ?? 'markdown';
  const data = new Inspector({ log, db }).export(id, { format });
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
  const body = text.endsWith('\n') ? text : text + '\n';
  if (flags.out) {
    writeFileSync(flags.out, body);
    print(`wrote ${flags.out} (${Buffer.byteLength(body)} bytes, format=${format})`, flags);
    return 0;
  }
  process.stdout.write(body);
  return 0;
}

function cmdStats(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const st = new Inspector({ log, db }).stats(id);
  out(flags, st, () => {
    const u = st.tokenUsage || {};
    print(`stats: ${st.title ?? id}`);
    print(`messages: ${st.messageCount}  by role: ${(st.messagesByRole || []).map(r => `${r.role ?? 'none'}=${r.n}`).join(', ')}`);
    print(`turns: ${st.turnCount}   turn diffs: ${st.turnDiffCount}`);
    print(`tokens: input=${u.input ?? 0} output=${u.output ?? 0} reasoning=${u.reasoning ?? 0} cache_read=${u.cache_read ?? 0} cache_write=${u.cache_write ?? 0}`);
    if (u.cost) print(`cost: $${Number(u.cost).toFixed(4)}`);
    print(`db rows belonging to session: ~${st.approxDbRows.total}`);
    print(`last activity: ${iso(st.lastActivityMs)}`);
  });
  return 0;
}

function cmdActive(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const st = new Safety({ log, db }).activeState(id);
  out(flags, { sessionId: id, ...st }, () => {
    print(`${id}: ${st.active ? 'ACTIVE/RUNNING' : 'not running'}`);
    for (const r of st.reasons) print(`  - ${r}`);
  });
  return st.active ? 3 : 0;
}

function cmdPlan(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const { entries, warnings } = new Safety({ log, db }).buildDeletePlan(id);
  out(flags, { sessionId: id, entries, warnings }, () => {
    print(`deletion plan for ${id}`);
    for (const e of entries) if (e.count) print(`  ${String(e.count).padStart(6)}  ${e.table}  [${e.kind}]`);
    for (const w of warnings) print(`  warn: ${w}`);
  });
  return 0;
}

async function cmdResume(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  if (!mcodeBinExists()) throw new Error(`mcode binary not found (${MCODE_BIN})`);
  const s = new Discovery({ log, db }).getSession(id);
  if (!s) throw new Error(`session not found: ${id}`);
  // mcode's top-level CLI has no --cwd flag (only `mcode exec` does).
  // The session already stores workspace_dir; we pass it as the child process
  // cwd so relative paths resolve inside the session's workspace.
  const args = ['--session', id];
  const cwd = s.workspace_dir || undefined;
  if (flags.dryRun) {
    out(flags, { args, cwd, bin: MCODE_BIN }, () =>
      print(`would launch: mcode ${args.join(' ')}${cwd ? `  (cwd: ${cwd})` : ''}`));
    return 0;
  }
  log.info(`resuming ${id} via: mcode ${args.join(' ')}${cwd ? `  cwd=${cwd}` : ''}`);
  const code = await new Promise(resolve => {
    const child = spawn(MCODE_BIN, args, { stdio: 'inherit', cwd });
    child.on('exit', c => resolve(c ?? 0));
    child.on('error', e => { stderr(`failed to launch mcode: ${e.message}`); resolve(1); });
  });
  return code;
}

// ------------------------------------------------------------------ doctor
async function cmdDoctor(flags, log) {
  const checks = [];
  const add = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); return ok; };

  const [major] = process.versions.node.split('.').map(Number);
  add('node >= 20', major >= 20, `v${process.versions.node}`);

  add('mcode install root', existsSync(MCODE_INSTALL_ROOT), MCODE_INSTALL_ROOT);
  add(`mcode release ${MCODE_RELEASE}`, existsSync(MCODE_PKG), MCODE_PKG);
  add('mcode binary', mcodeBinExists(), MCODE_BIN);
  add('mcode version readable', !!mcodeVersion(), mcodeVersion());

  add('runtime database present', dbExists(), DB_PATH);
  if (dbExists()) {
    try {
      const { betterSqlite } = await import('./sqlite.js');
      const D = betterSqlite();
      const db = new D(DB_PATH, { readonly: true, fileMustExist: true });
      add('better-sqlite3 loads', true, 'binding resolved from mcode install');
      try {
        const integrity = db.pragma('quick_check', { simple: true });
        add('sqlite quick_check', integrity === 'ok', String(integrity));
      } catch (e) { add('sqlite quick_check', false, e.message); }
      try {
        const need = ['local_runtime_sessions', 'local_runtime_message_rows', 'local_runtime_token_usage'];
        const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
        const missing = need.filter(t => !have.has(t));
        add('required tables', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : need.join(', '));
        const n = db.prepare('SELECT count(*) n FROM local_runtime_sessions').get().n;
        const locks = db.prepare('SELECT count(*) n FROM local_runtime_session_locks').get().n;
        add('sessions readable', true, `${n} session(s), ${locks} lock(s)`);
      } catch (e) { add('required tables', false, e.message); }
      try { db.close(); } catch { /* noop */ }
    } catch (e) {
      add('better-sqlite3 loads', false, e.message);
    }
  }

  for (const [name, dir] of [['state dir', MSM_DIR], ['log dir', MSM_LOG_DIR], ['backup dir', MSM_BACKUP_DIR]]) {
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, FS.W_OK);
      let count = '';
      if (dir === MSM_BACKUP_DIR) {
        try { count = `${statSync(dir) ? '' : ''}`; } catch { /* noop */ }
      }
      add(name + ' writable', true, dir + (count ? ` (${count})` : ''));
    } catch (e) { add(name + ' writable', false, `${dir}: ${e.message}`); }
  }

  // native ACP: best-effort — cold start measured ~8s on this host, so allow 20s
  if (mcodeBinExists()) {
    try {
      const { withAcp } = await import('./acp.js');
      const t0 = Date.now();
      const info = await Promise.race([
        withAcp(log, async acp => { await acp.initialize(); return acp.serverInfo ?? {}; }),
        new Promise((_, rej) => {
          const t = setTimeout(() => rej(new Error('timeout after 20s')), 20000);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
      add('native ACP reachable', true, `${JSON.stringify(info)} in ${Date.now() - t0}ms`);
    } catch (e) { add('native ACP reachable', false, e.message); }
  } else {
    add('native ACP reachable', false, 'mcode binary missing');
  }

  const failed = checks.filter(c => !c.ok);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ ok: failed.length === 0, checks }, null, 2) + '\n');
    return failed.length ? 1 : 0;
  }
  print(`mcode-sessions doctor  (mcode ${mcodeVersion()}, release ${MCODE_RELEASE})`, flags);
  print('', flags);
  for (const c of checks) {
    const mark = c.ok ? '  ok ' : ' FAIL';
    const w = termWidth();
    const base = `${mark}  ${c.name}`;
    if (c.detail) {
      const room = w - dispWidth(base) - 5;
      if (room > 10) print(`${base}  — ${clipTo(c.detail, room)}`, flags);
      else {
        print(base, flags);
        print(`        ${clipTo(c.detail, Math.max(10, w - 8))}`, flags);
      }
    } else print(base, flags);
  }
  print('', flags);
  print(failed.length ? `${failed.length} check(s) failed` : 'all checks passed', flags);
  return failed.length ? 1 : 0;
}

// ---- formatting ----
function cols() { return termWidth(); }

// One row: left = # + title(+meta), right = status + age — always clipped.
function formatRow(r, n, width = 80) {
  const st = r.status ?? '?';
  const arch = r.archived ? ' arch' : '';
  const age = relAge(r.updated_at_ms);
  const kind = r.session_kind && r.session_kind !== 'conversation' ? ` <${r.session_kind[0]}>` : '';
  const ws = (!r.workspace_dir || r.workspace_dir === '/root') ? '' : ` @${shortWs(r.workspace_dir)}`;
  const num = String(n).padStart(width < 46 ? 2 : 3);
  if (width < 46) {
    const right = `${st}${arch}`;
    const leftBudget = Math.max(6, width - 1 - dispWidth(num) - 1 - dispWidth(right));
    const title = clipTo(r.title ?? '(untitled)', leftBudget);
    return clipTo(`${num} ${title} ${right}`, width);
  }
  const right = `${st.padEnd(7)}${arch} ${age.padStart(4)}`;
  const fixed = 2 + dispWidth(num) + 2 + dispWidth(kind) + dispWidth(ws) + 2 + dispWidth(right);
  const title = clipTo(r.title ?? '(untitled)', Math.max(4, width - fixed));
  return clipTo(fitLR(`${num}  ${title}${kind}${ws}`, right, width), width);
}
