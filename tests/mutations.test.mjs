// Test harness: exercises every mutation and verifies the database afterwards.
// Additive ops first, destructive last. All destructive targets are disposable
// sessions created for this run (or forks of a real session, which are also
// disposable). The real user sessions are never mutated except read-only.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { AcpClient } = await import(join(ROOT, 'src', 'acp.js'));

const MSM = join(ROOT, 'bin', 'mcode-sessions');
const req = createRequire('/root/.minimax-code/releases/0.5.2/lib/node_modules/@minimax-ai/code/cli.js');
const D = req('better-sqlite3');
const DBP = '/root/.minimax/v2/sqlite/runtime-state.sqlite';
const ro = () => new D(DBP, { readonly: true, fileMustExist: true });

// A real session that carries messages; used only as a fork SOURCE (never deleted).
const FORK_SOURCE = 'mvs_d48a7326a72d44eca1f852f0287a3245';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
}
function sh(args) {
  const r = spawnSync('node', [MSM, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function jout(r) { try { return JSON.parse(r.out); } catch { return null; } }
function sess(id) {
  const db = ro();
  try { return db.prepare('SELECT session_id,title,status,archived,record_json,updated_at_ms FROM local_runtime_sessions WHERE session_id=?').get(id) ?? null; }
  finally { db.close(); }
}
function countRows(table, id) {
  const db = ro();
  try {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map(r => r.name);
    const key = cols.includes('session_id') ? 'session_id' : cols.find(c => /_session(_id)?$/.test(c));
    if (!key) return 0;
    return db.prepare(`SELECT count(*) n FROM "${table}" WHERE "${key}"=?`).get(id).n;
  } finally { db.close(); }
}

async function main() {
  console.log('=== setup: disposable sessions via native ACP (session/new) ===');
  const acp = new AcpClient({});
  await acp.initialize();
  const a = await acp.newSession({ cwd: '/tmp/msm-test' });
  const b = await acp.newSession({ cwd: '/tmp/msm-test' });
  await acp.close();
  const A = a.sessionId, B = b.sessionId;
  ok('created disposable A', !!A, A); ok('created disposable B', !!B, B);

  // --------------------------------------------------------------- rename
  console.log('\n=== rename ===');
  const before = sess(A);
  const r1 = sh(['rename', A, 'msm-rename-test-1', '--confirm', '--json']);
  const j1 = jout(r1);
  const after = sess(A);
  ok('rename exit 0', r1.code === 0, r1.err);
  ok('title updated in db', after.title === 'msm-rename-test-1', JSON.stringify(after));
  ok('record_json.title consistent', JSON.parse(after.record_json).title === 'msm-rename-test-1');
  ok('updated_at_ms advanced', after.updated_at_ms >= before.updated_at_ms, `${before.updated_at_ms} -> ${after.updated_at_ms}`);
  ok('report shows old+new title', j1 && j1.before.title !== j1.after.title, JSON.stringify(j1 && j1.before));
  console.log(`  old="${before.title}" new="${after.title}"`);

  // ------------------------------------------------------- archive / undo
  console.log('\n=== archive / unarchive ===');
  const r2 = sh(['archive', A, '--confirm', '--json']);
  ok('archive exit 0', r2.code === 0, r2.err);
  ok('archived=1 in db', sess(A).archived === 1);
  ok('record_json.archived consistent', JSON.parse(sess(A).record_json).archived === 1 || JSON.parse(sess(A).record_json).archived === true);
  ok('status/visibility preserved', sess(A).status === before.status);
  const r3 = sh(['unarchive', A, '--confirm', '--json']);
  ok('unarchive exit 0', r3.code === 0, r3.err);
  ok('archived=0 in db', sess(A).archived === 0);
  const r3b = sh(['unarchive', A, '--confirm', '--json']);
  ok('unarchive idempotent', r3b.code === 0 && sess(A).archived === 0, r3b.err);
  ok('title preserved through archive cycle', sess(A).title === 'msm-rename-test-1');

  // ---------------------------------------------------------- fork (native)
  console.log('\n=== fork (native ACP) ===');
  // The runtime requires the fork cwd to equal the source's workspace; the
  // tool must reject a mismatch up-front instead of leaking a raw error.
  const rMismatch = sh(['fork', FORK_SOURCE, '--cwd', '/tmp/elsewhere', '--json']);
  ok('fork rejects mismatched cwd', rMismatch.code === 1 && /stay in the source session/i.test(rMismatch.err + rMismatch.out), rMismatch.err);
  ok('mismatched fork changed nothing', !!sess(FORK_SOURCE));

  const r4 = sh(['fork', FORK_SOURCE, '--json']);
  const j4 = jout(r4);
  const forkId = j4?.newSessionId ?? null;
  ok('fork exit 0', r4.code === 0, r4.err + r4.out.slice(0, 200));
  ok('fork returned new session id', !!forkId && forkId.startsWith('mvs_'), r4.out.slice(0, 200));
  if (forkId) {
    ok('forked row exists', !!sess(forkId));
    ok('fork copied messages', countRows('local_runtime_message_rows', forkId) > 0, '');
    ok('fork landed in source workspace', sess(forkId).workspace_dir === sess(FORK_SOURCE).workspace_dir, sess(forkId)?.workspace_dir);
    ok('source session untouched', sess(FORK_SOURCE).title !== null);
  }

  // ------------------------------------------- delete: dry-run is a no-op
  console.log('\n=== delete: dry-run changes nothing ===');
  const rowsBefore = countRows('local_runtime_message_rows', FORK_SOURCE);
  const r5 = sh(['delete', FORK_SOURCE, '--dry-run', '--json']);
  const j5 = jout(r5);
  ok('dry-run exit 0', r5.code === 0, r5.err);
  ok('dry-run reports tables/rows', !!j5 && j5.rowsAffected > 0, JSON.stringify(j5).slice(0, 200));
  ok('dry-run target still exists', !!sess(FORK_SOURCE));
  ok('dry-run rows unchanged', countRows('local_runtime_message_rows', FORK_SOURCE) === rowsBefore);

  // ------------------------------------- delete: refuses an active session
  console.log('\n=== delete: refuses active/running session ===');
  const live = ro().prepare('SELECT session_id FROM local_runtime_session_locks WHERE expires_at_ms > ?').get(Date.now());
  if (live) {
    const r6 = sh(['delete', live.session_id, '--confirm', '--json']);
    const j6 = jout(r6);
    ok('refused with exit 3', r6.code === 3, `exit=${r6.code}`);
    ok('report says refused', !!j6 && j6.refused === true, JSON.stringify(j6).slice(0, 150));
    ok('active session still exists', !!sess(live.session_id));
    ok('no backup created for a refused op', !(j6 && j6.backupPath));
  } else { console.log('  (no live-locked session present; skipped)'); }

  // ------------------------------------ delete: real, with confirm + backup
  console.log('\n=== delete: real (A), confirmation + automatic backup ===');
  const r7 = sh(['delete', A, '--confirm', '--json']);
  const j7 = jout(r7);
  ok('delete exit 0', r7.code === 0, r7.err);
  ok('report committed', !!j7 && j7.committed === true, r7.out.slice(0, 300));
  ok('session row gone', sess(A) === null);
  ok('messages gone', countRows('local_runtime_message_rows', A) === 0);
  ok('fts_keys gone', countRows('local_runtime_session_fts_keys', A) === 0);
  ok('fts row gone', countRows('local_runtime_sessions_fts', A) === 0);
  ok('verification passed', !!j7 && j7.verified === true, JSON.stringify(j7 && j7.dependentCheck));
  ok('backup created and reported', !!j7 && !!j7.backupPath, String(j7 && j7.backupPath));

  console.log('\n=== delete: repeatable (B, and the fork) ===');
  const r8 = sh(['delete', B, '--confirm', '--json']);
  const j8 = jout(r8);
  ok('delete B exit 0', r8.code === 0 && sess(B) === null, r8.err);
  ok('delete B verified', !!j8 && j8.verified === true);
  if (forkId) {
    const r9 = sh(['delete', forkId, '--confirm', '--no-backup', '--json']);
    const j9 = jout(r9);
    ok('delete fork exit 0', r9.code === 0, r9.err);
    ok('fork gone', sess(forkId) === null);
    ok('fork messages gone', countRows('local_runtime_message_rows', forkId) === 0);
    ok('fork fts gone', countRows('local_runtime_sessions_fts', forkId) === 0);
    ok('backup skipped with --no-backup', !!j9 && j9.backupPath === null, String(j9 && j9.backupPath));
  }

  // --------------------------------- no other session was affected by all this
  console.log('\n=== collateral check ===');
  const total = ro().prepare('SELECT count(*) n FROM local_runtime_sessions').get().n;
  ok('total session count is sane (no mass deletion)', total > 15, `total=${total}`);
  ok('fork source survived', !!sess(FORK_SOURCE));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.log('FATAL', e); process.exit(2); });
