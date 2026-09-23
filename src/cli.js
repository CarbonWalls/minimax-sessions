// CLI (non-interactive) command surface.
import { Logger } from './log.js';
import { SqliteAdapter } from './sqlite.js';
import { Discovery } from './discovery.js';
import { Lifecycle } from './lifecycle.js';
import { Inspector } from './inspect.js';
import { Safety } from './safety.js';
import {
  DB_PATH, dbExists, mcodeBinExists, mcodeVersion, MCODE_BIN,
  SESSION_ID_PREFIX, parseFlags,
} from './env.js';

const HELP = `mcode-sessions — MiniMax Code session manager

usage:
  mcode-sessions                       interactive TUI (default, no arguments)
  mcode-sessions list [text]           list sessions
  mcode-sessions search <text>         search sessions by title
  mcode-sessions inspect <id>          show compact metadata
  mcode-sessions rename <id> <title>   rename a session
  mcode-sessions archive <id>          archive a session
  mcode-sessions unarchive <id>        unarchive a session
  mcode-sessions fork <id> [--cwd DIR] fork/clone via the native runtime
  mcode-sessions delete <id>           delete (--dry-run by default; --confirm to run)
  mcode-sessions export <id>           export (--format json|markdown|metadata)
  mcode-sessions stats <id>            usage / statistics
  mcode-sessions active <id>           report whether a session is running
  mcode-sessions plan <id>             dry-run deletion plan

filters:  --archived / --no-archived   --status <s>   --kind <k>   --workspace <dir>

safety:
  --dry-run              compute and show what would happen; change nothing
  --confirm              required to actually apply destructive operations
  --no-backup            skip the automatic pre-delete database backup
  --session <id>         select a session by exact id (scripting)

output / logging:
  --json                 machine-readable output
  --ascii                plain-ASCII UI (no box-drawing characters)
  --no-color             disable colour
  --debug / --verbose    write more to ~/.mcode-session-manager/logs/msm.log
`;

export async function runCli(argv) {
  const { flags, positional } = parseFlags(argv);
  const log = new Logger({ level: flags.debug ? 'debug' : (flags.verbose ? 'verbose' : 'info') });
  log.verbose(`cli start: positional=${JSON.stringify(positional)}`);

  if (flags.help || positional[0] === 'help') { print(HELP, flags); return 0; }
  if (flags.version) { print(`mcode-sessions 1.0.0 (mcode ${mcodeVersion()})`, flags); return 0; }

  const cmd = positional[0] ?? '';
  if (!cmd) {
    const { runTui } = await import('./tui.js');
    return runTui({ flags, log });
  }

  if (!dbExists()) {
    stderr(`runtime database not found: ${DB_PATH}`);
    stderr('set MSM_RUNTIME_DATA_DIR to override the data dir, or check your installation.');
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
      default:
        stderr(`unknown command: ${cmd}\n\n${HELP}`);
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
function print(s, flags) { if (flags?.json) return; process.stdout.write(s + '\n'); }
function stderr(s) { process.stderr.write(s + '\n'); }

function resolveId(positional, flags) {
  const id = String((flags.session || positional[1]) ?? '').trim();
  if (!id) throw new Error('no session id given (use an exact mvs_ id or --session <id>)');
  return id;
}
function assertExactId(id) {
  if (!id.startsWith(SESSION_ID_PREFIX))
    throw new Error(`expected an exact ${SESSION_ID_PREFIX}... session id (never a title)`);
}
function extraValue(key) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === key) return argv[++i];
  return undefined;
}
function extraFilters(flags) {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') out.status = argv[++i];
    else if (a === '--kind') out.kind = argv[++i];
    else if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--archived' || a === '--include-archived') out.archived = 'include';
    else if (a === '--no-archived' || a === '--exclude-archived') out.archived = 'exclude';
  }
  if (!('archived' in out) && flags.includeArchived === false) out.archived = 'exclude';
  return out;
}

function cmdList(args, flags, db, log) {
  const d = new Discovery({ log, db });
  const filters = extraFilters(flags);
  if (args[0] && !args[0].startsWith('-')) filters.q = args[0];
  const { rows, total } = d.list({ limit: 200, filters });
  if (flags.json) { process.stdout.write(JSON.stringify({ total, sessions: rows }, null, 2) + '\n'); return 0; }
  const fac = d.facetCounts();
  print(`mcode sessions  (mcode ${mcodeVersion()})  total=${total} archived=${fac.archived} locked=${fac.active}`, flags);
  print('-'.repeat(Math.min(60, process.stdout.columns || 60)), flags);
  if (!rows.length) { print('(no sessions match)', flags); return 0; }
  rows.forEach((r, i) => print(formatRow(r, i + 1, cols()), flags));
  return 0;
}

function cmdSearch(args, flags, db, log) {
  const q = args[0];
  if (!q) throw new Error('search requires a text argument');
  const { rows, total } = new Discovery({ log, db }).list({ limit: 200, filters: { q } });
  if (flags.json) { process.stdout.write(JSON.stringify({ query: q, total, sessions: rows }, null, 2) + '\n'); return 0; }
  print(`search "${q}" — ${total} match(es)`, flags);
  rows.forEach((r, i) => print(formatRow(r, i + 1, cols()), flags));
  return 0;
}

function cmdInspect(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const data = new Inspector({ log, db }).inspect(id);
  if (flags.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return 0; }
  const s = data.session;
  print(`session: ${s.title ?? '(untitled)'}`, flags);
  print(`id: ${s.session_id}`, flags);
  print(`status: ${s.status}${s.archived ? ' (archived)' : ''}   visibility: ${s.visibility}   kind: ${s.session_kind}`, flags);
  print(`runtime: ${s.runtime}   agent: ${s.agent_name}   type: ${s.session_type}`, flags);
  print(`workspace: ${s.workspace_dir}${s.project_workspace_dir && s.project_workspace_dir !== s.workspace_dir ? ' (project: ' + s.project_workspace_dir + ')' : ''}`, flags);
  if (s.parent_session_id) print(`parent: ${s.parent_session_id}   children: ${data.childSessionCount}`, flags);
  else print(`child sessions: ${data.childSessionCount}`, flags);
  print(`created: ${iso(s.created_at_ms)}   updated: ${iso(s.updated_at_ms)}`, flags);
  print(`messages: ${data.messageCount}   token rows: ${data.tokenUsage?.rows ?? 0}`, flags);
  if (data.locks.length) print(`locks: ${data.locks.map(l => `${l.owner_kind} exp ${iso(l.expires_at_ms)}`).join(', ')}`, flags);
  if (s.error_message) print(`error: ${s.error_message}`, flags);
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
  if (flags.json) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return 0; }
  if (r.unchanged) { print('title unchanged', flags); return 0; }
  print(`renamed: "${r.before.title ?? '(untitled)'}" -> "${r.after.title}"`, flags);
  return 0;
}

async function cmdArchive(positional, flags, db, log, on) {
  const id = resolveId(positional, flags); assertExactId(id);
  if (!flags.confirm && !flags.nonInteractive) {
    print(`${on ? 'archive' : 'unarchive'} ${id} — re-run with --confirm to apply`, flags);
    return 0;
  }
  const r = new Lifecycle({ log, db }).setArchived(id, on);
  if (flags.json) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return 0; }
  if (r.unchanged) { print(`already ${on ? 'archived' : 'not archived'}`, flags); return 0; }
  print(`${on ? 'archived' : 'unarchived'}: ${id} (archived=${r.after.archived})`, flags);
  return 0;
}

async function cmdFork(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const cwd = extraValue('--cwd') ?? extraValue('--workspace');
  if (!mcodeBinExists()) throw new Error(`mcode binary not found (${MCODE_BIN}); native fork unavailable`);
  const r = await new Lifecycle({ log, db }).fork(id, { cwd });
  if (flags.json) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); return 0; }
  print(`forked ${id} -> ${r.newSessionId}`, flags);
  print(`title: ${r.session?.title ?? '(none)'}  workspace: ${r.session?.workspace_dir}`, flags);
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
  const format = extraValue('--format') ?? 'markdown';
  const data = new Inspector({ log, db }).export(id, { format });
  process.stdout.write(typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
  return 0;
}

function cmdStats(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const st = new Inspector({ log, db }).stats(id);
  if (flags.json) { process.stdout.write(JSON.stringify(st, null, 2) + '\n'); return 0; }
  const u = st.tokenUsage || {};
  print(`stats: ${st.title ?? id}`, flags);
  print(`messages: ${st.messageCount}  by role: ${(st.messagesByRole || []).map(r => `${r.role ?? 'none'}=${r.n}`).join(', ')}`, flags);
  print(`turns: ${st.turnCount}   turn diffs: ${st.turnDiffCount}`, flags);
  print(`tokens: input=${u.input ?? 0} output=${u.output ?? 0} reasoning=${u.reasoning ?? 0} cache_read=${u.cache_read ?? 0} cache_write=${u.cache_write ?? 0}`, flags);
  print(`db rows belonging to session: ~${st.approxDbRows.total}`, flags);
  print(`last activity: ${iso(st.lastActivityMs)}`, flags);
  return 0;
}

function cmdActive(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const st = new Safety({ log, db }).activeState(id);
  if (flags.json) { process.stdout.write(JSON.stringify({ sessionId: id, ...st }, null, 2) + '\n'); return 0; }
  print(`${id}: ${st.active ? 'ACTIVE/RUNNING' : 'not running'}`, flags);
  for (const r of st.reasons) print(`  - ${r}`, flags);
  return st.active ? 3 : 0;
}

function cmdPlan(positional, flags, db, log) {
  const id = resolveId(positional, flags); assertExactId(id);
  const { entries, warnings } = new Safety({ log, db }).buildDeletePlan(id);
  if (flags.json) { process.stdout.write(JSON.stringify({ sessionId: id, entries, warnings }, null, 2) + '\n'); return 0; }
  print(`deletion plan for ${id}`, flags);
  for (const e of entries) if (e.count) print(`  ${String(e.count).padStart(6)}  ${e.table}  [${e.kind}]`, flags);
  for (const w of warnings) print(`  warn: ${w}`, flags);
  return 0;
}

// ---- formatting ----
function cols() { return process.stdout.columns || 80; }

function formatRow(r, n, width = 80) {
  const title = trunc(r.title ?? '(untitled)', Math.max(8, Math.min(44, width - 36)));
  const st = r.status ?? '?';
  const arch = r.archived ? ' [arch]' : '';
  const kind = r.session_kind && r.session_kind !== 'conversation' ? ` <${r.session_kind[0]}>` : '';
  const age = relAge(r.updated_at_ms);
  const ws = (!r.workspace_dir || r.workspace_dir === '/root') ? '' : ` @${shortWs(r.workspace_dir)}`;
  if (width < 46) return `${String(n).padStart(2)} ${title} ${st}${arch}`;
  return `${String(n).padStart(3)}  ${title}${kind}${ws}  ${st}${arch}  ${age}`;
}
function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function shortWs(w) { const p = String(w).split('/'); return p[p.length - 1] || w; }
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
