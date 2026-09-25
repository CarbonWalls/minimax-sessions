// Session repair.
//
// Detects and repairs "corrupted" sessions — the kind that break delete/load
// and were originally caused by a flaw in the deletion planner:
//
//   * Safety.buildDeletePlan did not topologically order deletes, so a parent
//     table (e.g. local_runtime_turn_ingress) could be removed before its
//     cascade child (local_runtime_turn_ingress_sequences), leaving child rows
//     behind whose owning parent is gone.
//   * A partial / aborted delete could leave rows in session-keyed tables that
//     reference a session id that no longer has a row in local_runtime_sessions.
//
// Both classes of corruption are *provably* safe to remove: the row's owning
// parent row (or owning session) no longer exists anywhere, so deleting the
// residue cannot touch another session's live data. This module never guesses —
// every fix is derived from the live schema and driven by foreign-key ownership.
//
// Safety model:
//   * detection (dry-run) is the default and changes nothing;
//   * writes require an explicit flag;
//   * the database is backed up first (unless --no-backup);
//   * every change runs inside one transaction and is verified afterwards.
import { SqliteAdapter, quoteIdent, isSessionKeyCol, CASCADE_ID_COLS } from './sqlite.js';
import { Safety } from './safety.js';
import { Discovery } from './discovery.js';
import { Inspector } from './inspect.js';

// Registries that are not per-session data; never touched even by residue
// purge (conservative mirror of Safety's own exclusions).
const SHARED_TABLES = new Set([
  'agents', 'local_runtime_agents', 'local_runtime_projects', 'local_runtime_preferences',
]);

// Columns that express *ownership* of a row by a session (as opposed to a
// reference to some other session). from_session/to_session are cross-links and
// must never be used to classify a row as residue.
export function ownershipCols(cols) {
  return cols.filter(c => c === 'session_id' || /_session_id$/.test(c));
}

export class Repairer {
  constructor({ log, db } = {}) {
    this.log = log;
    this.db = db ?? new SqliteAdapter({ log });
    this.safety = new Safety({ log, db: this.db });
    this.discovery = new Discovery({ log, db: this.db });
    this.inspector = new Inspector({ log, db: this.db });
    this._pairs = null;
  }

  // Derived cascade parent/child pairs (child table, id column, parent table),
  // mirroring Safety.buildDeletePlan's cascade discovery. A child is a row whose
  // id column is owned by a parent row's PRIMARY KEY.
  cascadePairs() {
    if (this._pairs) return this._pairs;
    const sessionKeyed = this.db.tablesWithSessionKey();
    const pairs = [];
    for (const t of this.db.tables()) {
      if (sessionKeyed.includes(t)) continue;
      for (const c of this.db.columns(t)) {
        if (!CASCADE_ID_COLS.includes(c)) continue;
        const parent = sessionKeyed.find(p =>
          p !== t && this.db.columns(p).includes(c) && this.db.pk(p).includes(c));
        if (parent) pairs.push({ table: t, idCol: c, parent });
      }
    }
    this._pairs = pairs;
    return pairs;
  }

  // ----------------------------------------------------------------- detect
  // Structured corruption report for one session. Never writes.
  detect(id) {
    const issues = [];
    const s = this.discovery.getSession(id);

    if (!s) {
      issues.push({
        type: 'missing-session', table: 'local_runtime_sessions', rows: 1, severity: 'error',
        reason: 'no local_runtime_sessions row exists for this id',
        suggested: 'purge any leftover rows that still reference it (repair)',
      });
    }

    // Can the session be loaded at all? (self-contained probe so it can never
    // recurse into Inspector.inspect, which itself reports these issues.)
    try {
      this.discovery.getSession(id);
      this.discovery.messageCount(id);
    } catch (e) {
      issues.push({
        type: 'load-failure', table: '*', rows: 0, severity: 'error',
        reason: `session failed to load: ${e.message}`,
        suggested: 'back up, then repair (it may also need `plan <id>` to review the delete plan)',
      });
    }

    // Cascade orphans. A child row whose owning parent row is gone everywhere is
    // residue from an out-of-order delete (the historical incident).
    for (const { table, idCol, parent } of this.cascadePairs()) {
      const { n, ids } = this._orphanCount(table, idCol, parent);
      if (n > 0) {
        issues.push({
          type: 'cascade-orphans', table, rows: n, severity: 'error',
          reason: `${n} row(s) in ${table} whose ${idCol} has no owning row left in ${parent} (deleted out of order / partial delete)`,
          suggested: 'purge these orphaned rows with repair',
          fix: { action: 'delete-orphans', table, idCol, parent, count: n, exampleIds: ids.slice(0, 5) },
        });
      }
    }

    // Delete-plan validity for the session (if it exists): a cascade child with
    // rows owned by this session whose parent-for-session rows are zero would
    // have caused the old planner's row-count mismatch (rollback) — the same
    // corruption, now surfaced as a concrete, actionable issue.
    if (s) {
      let planEntries = null;
      let planError = null;
      try { planEntries = this.safety.buildDeletePlan(id).entries; }
      catch (e) { planError = e.message; }
      if (planError) {
        issues.push({
          type: 'plan-failure', table: '*', rows: 0, severity: 'error',
          reason: `could not build a deletion plan: ${planError}`,
          suggested: 'this usually indicates a schema/constraint problem; repair and review `plan <id>`',
        });
      } else if (planEntries) {
        for (const e of planEntries) {
          if (e.kind !== 'cascade' || !e.idCol) continue;
          const owned = this._ownedBySession(e.table, e.idCol, e.parentTable, id);
          if ((owned ?? 0) > 0 && !(e.count ?? 0)) {
            // The plan's subquery (which reads from the parent for this session)
            // finds nothing while raw child rows exist -> the classic mismatch.
            issues.push({
              type: 'plan-mismatch', table: e.table, rows: owned, severity: 'error',
              reason: `${owned} orphaned child row(s) in ${e.table} for this session (their parent rows are gone) — the delete plan would mismatch`,
              suggested: 'purge these orphaned rows with repair so delete can complete',
              fix: {
                action: 'delete-orphans-session', table: e.table, idCol: e.idCol,
                parent: e.parentTable, count: owned,
              },
            });
          }
        }
      }
    }

    // Session residue: rows in session-keyed tables whose session id no longer
    // exists anywhere (partial-delete leftovers). Global, but reported here so a
    // single repair pass can clean the whole residue set.
    for (const t of this.db.tablesWithSessionKey()) {
      if (SHARED_TABLES.has(t) || t === 'local_runtime_sessions') continue;
      for (const k of ownershipCols(this.db.columns(t))) {
        const n = this._residueCount(t, k);
        if (n > 0) {
          issues.push({
            type: 'session-residue', table: t, rows: n, severity: 'warn',
            reason: `${n} row(s) in ${t} reference ${k} values with no session row (partial delete residue)`,
            suggested: 'purge these orphaned rows with repair',
            fix: { action: 'delete-residue', table: t, key: k, count: n },
          });
        }
      }
    }

    return {
      sessionId: id,
      exists: !!s,
      healthy: issues.length === 0,
      issues,
    };
  }

  // Global corruption scan across all data (cascade orphans + session residue),
  // plus any session rows that fail to load. Detection only.
  scan() {
    const issues = [];
    for (const { table, idCol, parent } of this.cascadePairs()) {
      const { n } = this._orphanCount(table, idCol, parent);
      if (n > 0) issues.push({ type: 'cascade-orphans', table, rows: n, severity: 'error',
        reason: `${n} orphaned row(s) (${idCol} has no owning row in ${parent})`,
        suggested: 'repair to purge' });
    }
    for (const t of this.db.tablesWithSessionKey()) {
      if (SHARED_TABLES.has(t) || t === 'local_runtime_sessions') continue;
      for (const k of ownershipCols(this.db.columns(t))) {
        const n = this._residueCount(t, k);
        if (n > 0) issues.push({ type: 'session-residue', table: t, rows: n, severity: 'warn',
          reason: `${n} row(s) reference ${k} with no session row`,
          suggested: 'repair to purge' });
      }
    }
    // best-effort per-session load check (bounded to keep a scan cheap)
    const unloadable = [];
    let checked = 0;
    for (const row of this.db.read().prepare(
      `SELECT session_id FROM local_runtime_sessions ORDER BY updated_at_ms DESC LIMIT 2000`).all()) {
      checked++;
      try { this.inspector.inspect(row.session_id); }
      catch (e) { unloadable.push({ sessionId: row.session_id, reason: e.message }); }
    }
    return { sessionsChecked: checked, unloadable, issues, healthy: issues.length === 0 && unloadable.length === 0 };
  }

  // ----------------------------------------------------------------- repair
  // Detect + (with confirm) fix. Dry-run by default. Writes only after an
  // explicit flag, inside one transaction, backed up first, verified after.
  async repair(id, { dryRun = true, confirm = false, noBackup = false } = {}) {
    const detected = this.detect(id);
    const report = {
      sessionId: id,
      exists: detected.exists,
      healthy: detected.healthy,
      dryRun,
      issues: detected.issues,
      fixes: detected.issues.map(i => i.fix).filter(Boolean),
      backupPath: null,
    };

    if (report.fixes.length === 0) {
      return { ...report, nothingToRepair: true, applied: [] };
    }
    if (dryRun) {
      return { ...report, dryRun: true, applied: [] };
    }
    if (!confirm) {
      return { ...report, needsConfirm: true, applied: [] };
    }

    // Backup before any write.
    if (!noBackup) {
      try { report.backupPath = (await this.safety.backup({ label: 'pre-repair' })).path; }
      catch (e) { throw new Error(`backup failed, aborting repair (nothing changed): ${e.message}`); }
    }

    // Build concrete DELETE statements for each fix. Every fix is derived from
    // ownership and is provably safe (the owning parent/session is gone).
    const stmts = report.fixes.map(f => this._fixStatement(f)).filter(Boolean);
    const applied = [];
    let outcome = 'unknown';
    const db = this.db.write();
    try {
      const tx = db.transaction(() => {
        for (const st of stmts) {
          const r = db.prepare(st.sql).run(...(st.params ?? []));
          applied.push({ action: st.action, table: st.table, expected: st.count, deleted: r.changes });
          if (r.changes !== st.count) {
            throw new Error(`${st.action} on ${st.table}: expected ${st.count} rows, deleted ${r.changes}`);
          }
        }
      });
      tx();
      outcome = 'committed';
    } catch (e) {
      outcome = 'rolled-back';
      this.log?.error(`repair failed for ${id}: ${e.message}`);
      this.db.closeWrite();
      return { ...report, failed: true, outcome, applied, error: e.message };
    } finally {
      this.db.closeWrite();
    }

    // Post-repair verification: re-run detection with a FRESH read connection
    // (reusing a connection opened before the write can read a stale WAL
    // snapshot) and count how many fixable issues remain. Verification must
    // never throw the whole repair — a hiccup here only downgrades `verified`,
    // it does not undo the committed fix.
    let after;
    let verifyError = null;
    try {
      this.db.close(); // drop cached read/write connections
      after = this.detect(id);
    } catch (e) {
      this.log?.warn(`post-repair verification could not run: ${e.message}`);
      return { ...report, committed: true, outcome, applied, verified: false, verifyError: e.message, remainingIssues: [] };
    }
    const remainingFixable = after.issues.filter(i => i.fix).length;
    return {
      ...report,
      committed: true,
      outcome,
      applied,
      remainingFixable,
      verified: remainingFixable === 0,
      remainingIssues: after.issues,
    };
  }

  // ------------------------------------------------------------- internals
  _orphanCount(child, idCol, parent) {
    const c = quoteIdent(child), ic = quoteIdent(idCol), p = quoteIdent(parent);
    try {
      const r = this.db.read().prepare(
        `SELECT count(*) n FROM ${c} WHERE ${ic} NOT IN (SELECT ${ic} FROM ${p})`).get();
      let ids = [];
      try {
        ids = this.db.read().prepare(
          `SELECT DISTINCT ${ic} id FROM ${c} WHERE ${ic} NOT IN (SELECT ${ic} FROM ${p}) LIMIT 5`)
          .all().map(x => x.id);
      } catch { /* best effort */ }
      return { n: r?.n ?? 0, ids };
    } catch (e) { this.log?.debug(`orphan count failed ${child}: ${e.message}`); return { n: 0, ids: [] }; }
  }

  _ownedBySession(child, idCol, parent, id) {
    const pkeys = this.db.columns(parent).filter(isSessionKeyCol);
    if (!pkeys.length) return 0;
    const pwhere = pkeys.map(k => `${quoteIdent(k)} = ?`).join(' OR ');
    const sql = `SELECT count(*) n FROM ${quoteIdent(child)} WHERE ${quoteIdent(idCol)}
                 IN (SELECT ${quoteIdent(idCol)} FROM ${quoteIdent(parent)} WHERE ${pwhere})`;
    try { return this.db.read().prepare(sql).get(...pkeys.map(() => id)).n; }
    catch (e) { this.log?.debug(`ownedBySession failed ${child}: ${e.message}`); return 0; }
  }

  _residueCount(table, key) {
    const sql = `SELECT count(*) n FROM ${quoteIdent(table)} WHERE ${quoteIdent(key)}
                 NOT IN (SELECT session_id FROM local_runtime_sessions)`;
    try { return this.db.read().prepare(sql).get().n; }
    catch (e) { this.log?.debug(`residue count failed ${table}: ${e.message}`); return 0; }
  }

  _fixStatement(fix) {
    if (!fix) return null;
    if (fix.action === 'delete-orphans' || fix.action === 'delete-orphans-session') {
      const c = quoteIdent(fix.table), ic = quoteIdent(fix.idCol), p = quoteIdent(fix.parent);
      return {
        action: fix.action, table: fix.table, count: fix.count,
        sql: `DELETE FROM ${c} WHERE ${ic} NOT IN (SELECT ${ic} FROM ${p})`,
        params: [],
      };
    }
    if (fix.action === 'delete-residue') {
      const sql = `DELETE FROM ${quoteIdent(fix.table)} WHERE ${quoteIdent(fix.key)}
                   NOT IN (SELECT session_id FROM local_runtime_sessions)`;
      return { action: fix.action, table: fix.table, count: fix.count, sql, params: [] };
    }
    return null;
  }
}
