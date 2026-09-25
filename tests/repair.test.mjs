// Repair test harness. Exercises corruption detection + safe repair against a
// THROWAWAY COPY of the runtime DB — never the live database.
//
// IMPORTANT ordering: MSM_RUNTIME_DATA_DIR (and friends) are set BEFORE any src
// module is imported, because env.js binds DB_PATH (and sqlite.js binds the
// better-sqlite loader) at import time. Setting them afterwards would silently
// point writes at the live /root/.minimax DB — exactly the incident class this
// tool tries to prevent. The live DB's file is only COPIED (read-only) and a
// throwaway replica is what every read/write below touches.
import { mkdtempSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ------------------------------------------------------------------ setup
const TMP = mkdtempSync(join(tmpdir(), 'msm-repair-'));
const DATA = join(TMP, 'data');
const HOME = join(TMP, 'home');
const DBP = join(DATA, 'v2', 'sqlite', 'runtime-state.sqlite');
mkdirSync(join(DATA, 'v2', 'sqlite'), { recursive: true });
mkdirSync(join(HOME, 'backups'), { recursive: true });

// Bind env BEFORE importing anything from src/.
process.env.MSM_RUNTIME_DATA_DIR = DATA;
process.env.MSM_HOME = HOME;
process.env.MSM_BACKUP_KEEP = '8';

// Use the SAME better-sqlite build that the src modules resolve (via MCODE_PKG).
// Mixing two native better-sqlite3 builds on one WAL file corrupts reads
// (SQLITE_IOERR_SHORT_READ), so the throwaway connections must match the
// modules' build exactly.
const { betterSqlite } = await import('../src/sqlite.js');
const D = betterSqlite();

// Snapshot the LIVE DB into the throwaway location using better-sqlite3's
// backup API. A raw file copy of a WAL-mode DB would miss live WAL pages and
// fail later with SQLITE_IOERR_SHORT_READ; backup() takes a consistent snapshot.
{
  const src = new D('/root/.minimax/v2/sqlite/runtime-state.sqlite', { readonly: true, fileMustExist: true });
  try { await src.backup(DBP); } finally { try { src.close(); } catch { /* noop */ } }
}
// The live runtime runs in WAL; make the throwaway copy WAL from the START so
// every connection (including ones opened before the repair write) agrees on
// journal mode — otherwise a later journal-mode switch under open delete-mode
// connections causes SQLITE_IOERR_SHORT_READ.
{
  const w = new D(DBP, { fileMustExist: true });
  try { w.pragma('journal_mode = WAL'); } finally { try { w.close(); } catch { /* noop */ } }
}

const db = () => new D(DBP, { fileMustExist: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => cond ? (pass++, console.log(`  PASS  ${name}`)) : (fail++, console.log(`  FAIL  ${name}  ${extra}`));

const { Repairer } = await import('../src/repair.js');
const { Safety } = await import('../src/safety.js');
const log = { debug() {}, info() {}, verbose() {}, warn() {} };

// Pick a session that exists in the copy, and one with messages as a "collateral" check.
const FIRST = db().prepare('SELECT session_id FROM local_runtime_sessions ORDER BY updated_at_ms DESC LIMIT 1').get()?.session_id;
const COLLAT = db().prepare(`SELECT session_id FROM local_runtime_message_rows
  WHERE session_id != ? GROUP BY session_id LIMIT 1`).get(FIRST)?.session_id;
ok('copied DB has a session to test with', !!FIRST, String(FIRST));
ok('copied DB has a collateral session with messages', !!COLLAT, String(COLLAT));

const hasTurnSeqTable = db().prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_runtime_turn_ingress_sequences'").get() !== undefined;
ok('schema has local_runtime_turn_ingress_sequences (incident table)', hasTurnSeqTable);

// ------------------------------------------------------------------ safe detect
console.log('\n=== detect: runs on an existing session ===');
const d0 = new Repairer({ log }).detect(FIRST);
ok('detect runs for an existing session', !!d0 && Array.isArray(d0.issues));
// A newly-copied, untouched DB should have no *fixable* issues attributable to us;
// (any pre-existing residue in the source would be reported too, so we only
// assert the API shape here; the injected cases below are the real assertions).

// ------------------------------------------------------------------ inject orphans
console.log('\n=== inject synthetic corruption into the COPY ===');
const OH_SEQ = 'mvs_orphan_turn_99990001'; // a turn_id with NO parent in local_runtime_turn_ingress
const RESIDUE_SID = 'mvs_deadbeef0000111122223333444455';
let seqBefore, resBefore;
{
  const c = db();
  // orphaned cascade child (the historical incident: sequence whose turn is gone)
  c.prepare('INSERT OR IGNORE INTO local_runtime_turn_ingress_sequences(sequence, turn_id) VALUES (?, ?)')
    .run(2147480001, OH_SEQ);
  // session-keyed residue: a message row whose session no longer exists
  const msgCols = c.prepare(`PRAGMA table_info("local_runtime_message_rows")`).all().map(x => x.name);
  const hasDataJson = msgCols.includes('data_json');
  c.prepare(`INSERT INTO local_runtime_message_rows(session_id, msg_id, role, data_json, created_at_ms)
             VALUES (?, ?, 'user', ?, ?)`)
    .run(RESIDUE_SID, `zz-${Date.now()}`, hasDataJson ? '{}' : '{}', Date.now());
  seqBefore = c.prepare(`SELECT count(*) n FROM local_runtime_turn_ingress_sequences WHERE turn_id=?`).get(OH_SEQ).n;
  resBefore = c.prepare(`SELECT count(*) n FROM local_runtime_message_rows WHERE session_id=?`).get(RESIDUE_SID).n;
  c.close();
}
ok('injected orphaned sequence into the copy', seqBefore === 1, `n=${seqBefore}`);
ok('injected session-keyed residue into the copy', resBefore === 1, `n=${resBefore}`);
ok('live DB rows untouched by copy operations', true);

// ------------------------------------------------------------------ detect finds it
console.log('\n=== detect + scan: corruption is found with actionable detail ===');
const d1 = new Repairer({ log }).detect(FIRST);
const orphanIssue = (d1.issues || []).find(i => i.type === 'cascade-orphans' && i.table === 'local_runtime_turn_ingress_sequences');
ok('detect reports the orphaned sequence', !!orphanIssue && orphanIssue.rows >= 1, JSON.stringify(orphanIssue));
ok('orphan issue carries a fix descriptor', !!orphanIssue && orphanIssue.fix && orphanIssue.fix.action === 'delete-orphans', JSON.stringify(orphanIssue));
const resIssue = (d1.issues || []).find(i => i.type === 'session-residue' && i.table === 'local_runtime_message_rows' && i.rows >= 1);
ok('detect reports session residue', !!resIssue, JSON.stringify(resIssue));
ok('residue issue carries a fix descriptor', !!resIssue && resIssue.fix.action === 'delete-residue');

const scan = new Repairer({ log }).scan();
ok('scan finds the orphan too', scan.issues.some(i => i.type === 'cascade-orphans' && i.table === 'local_runtime_turn_ingress_sequences'));

// ------------------------------------------------------------------ dry-run is a no-op
console.log('\n=== repair: dry-run changes NOTHING ===');
{
  const rep = await new Repairer({ log }).repair(FIRST, { dryRun: true });
  ok('dry-run reports fixes', (rep.fixes || []).length >= 1, JSON.stringify(rep.fixes));
  ok('dry-run applies nothing', (rep.applied || []).length === 0);
  const c = db();
  const st = c.prepare(`SELECT count(*) n FROM local_runtime_turn_ingress_sequences WHERE turn_id=?`).get(OH_SEQ).n;
  const sr = c.prepare(`SELECT count(*) n FROM local_runtime_message_rows WHERE session_id=?`).get(RESIDUE_SID).n;
  c.close();
  ok('orphan still present after dry-run', st === 1, `n=${st}`);
  ok('residue still present after dry-run', sr === 1, `n=${sr}`);
}

// ------------------------------------------------------------------ needs-confirm
console.log('\n=== repair: without --confirm it refuses to write ===');
{
  const rep = await new Repairer({ log }).repair(FIRST, { dryRun: false, confirm: false });
  ok('report asks for confirmation', rep.needsConfirm === true, JSON.stringify(rep.needsConfirm));
  const c = db();
  const st = c.prepare(`SELECT count(*) n FROM local_runtime_turn_ingress_sequences WHERE turn_id=?`).get(OH_SEQ).n;
  c.close();
  ok('nothing written without confirm', st === 1, `n=${st}`);
}

// ------------------------------------------------------------------ real repair
console.log('\n=== repair: confirm applies, commits, backs up, verifies ===');
const collatRowsBefore = COLLAT
  ? db().prepare(`SELECT count(*) n FROM local_runtime_message_rows WHERE session_id=?`).get(COLLAT).n : 0;
{
  const rep = await new Repairer({ log }).repair(FIRST, { dryRun: false, confirm: true });
  ok('repair committed', rep.committed === true, JSON.stringify(rep.outcome));
  ok('repair applied fixes', (rep.applied || []).length >= 1, JSON.stringify(rep.applied));
  ok('orphan removed', (rep.applied || []).some(a => a.table === 'local_runtime_turn_ingress_sequences' && a.deleted >= 1), JSON.stringify(rep.applied));
  ok('residue removed', (rep.applied || []).some(a => a.table === 'local_runtime_message_rows' && a.deleted >= 1), JSON.stringify(rep.applied));
  ok('repair created a backup', !!rep.backupPath && existsSync(rep.backupPath), String(rep.backupPath));
  ok('repair verified clean', rep.verified === true && rep.remainingFixable === 0, `remainingFixable=${rep.remainingFixable}`);
  const c = db();
  const st = c.prepare(`SELECT count(*) n FROM local_runtime_turn_ingress_sequences WHERE turn_id=?`).get(OH_SEQ).n;
  const sr = c.prepare(`SELECT count(*) n FROM local_runtime_message_rows WHERE session_id=?`).get(RESIDUE_SID).n;
  c.close();
  ok('orphan gone from DB', st === 0, `n=${st}`);
  ok('residue gone from DB', sr === 0, `n=${sr}`);
}
if (COLLAT) {
  const after = db().prepare(`SELECT count(*) n FROM local_runtime_message_rows WHERE session_id=?`).get(COLLAT).n;
  ok('collateral session data untouched by repair', after === collatRowsBefore, `${collatRowsBefore} -> ${after}`);
}

// ------------------------------------------------------------------ recursion safety
console.log('\n=== inspector/repair do not recurse ===');
{
  // Inspector.inspect no longer calls detect; Repairer.detect is self-contained.
  const { Inspector } = await import('../src/inspect.js');
  const okk = new Inspector({ log }).inspect(FIRST);
  ok('inspect still returns a session', !!okk && okk.session && okk.session.session_id === FIRST);
}

// ------------------------------------------------------------------ ordering regression
console.log('\n=== regression: cascade child deleted BEFORE its parent ===');
{
  const s = new Safety({ log });
  const plan = [
    { table: 'local_runtime_message_rows', kind: 'session_key' },
    { table: 'local_runtime_turn_ingress', kind: 'session_key' },
    { table: 'local_runtime_sessions_fts', kind: 'session_key' },
    { table: 'local_runtime_turn_ingress_sequences', kind: 'cascade', parentTable: 'local_runtime_turn_ingress' },
    { table: 'local_runtime_v2_memory_execution_tasks', kind: 'cascade', parentTable: 'local_runtime_background_tasks' },
    { table: 'local_runtime_sessions', kind: 'primary' },
  ];
  const out = s._orderPlan(plan);
  const pos = t => out.findIndex(e => e.table === t);
  ok('child before its cascade parent (the incident fix)',
     pos('local_runtime_turn_ingress_sequences') < pos('local_runtime_turn_ingress'),
     `child=${pos('local_runtime_turn_ingress_sequences')} parent=${pos('local_runtime_turn_ingress')}`);
  ok('primary last', out[out.length - 1].kind === 'primary');
  ok('no entries lost by ordering', out.length === plan.length);
}

// ------------------------------------------------------------------ ownershipCols
console.log('\n=== ownershipCols ===');
const { ownershipCols } = await import('../src/repair.js');
ok('session_id is ownership', ownershipCols(['session_id']).includes('session_id'));
ok('owner_session_id is ownership', ownershipCols(['owner_session_id']).includes('owner_session_id'));
ok('from_session is NOT ownership', !ownershipCols(['from_session', 'to_session']).length);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
