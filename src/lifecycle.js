// Runtime/lifecycle adapter.
// - rename / archive / unarchive / delete: NO accessible native entrypoint
//   (ACP has no such methods; the Desktop HTTP API is not listening) ->
//   conservative transactional SQLite that mirrors the runtime's columnar
//   semantics. See RESEARCH.md.
// - fork: the NATIVE ACP `session/fork` is used. If it is unavailable the tool
//   refuses rather than faking a row copy.
import { Safety } from './safety.js';
import { Discovery } from './discovery.js';
import { SqliteAdapter, quoteIdent } from './sqlite.js';
import { withAcp } from './acp.js';

const NOW = () => Date.now();
const CASCADE_PROBE_CHUNK = 400; // ids per verification query

export class Lifecycle {
  constructor({ log, db, acpAvailable } = {}) {
    this.log = log;
    this.db = db ?? new SqliteAdapter({ log });
    this.safety = new Safety({ log, db: this.db });
    this.discovery = new Discovery({ log, db: this.db });
    this._acpAvailable = acpAvailable;
  }

  _requireExists(id) {
    if (!this.discovery.exists(id)) throw new Error(`session not found: ${id} (no row in local_runtime_sessions)`);
  }

  // keep the record_json field in step with the authoritative column
  _updateColumn(id, column, value, recordField, { updatedAtMs = NOW() } = {}) {
    this._requireExists(id);
    const db = this.db.write();
    const tx = db.transaction(() => {
      const row = db.prepare('SELECT record_json FROM local_runtime_sessions WHERE session_id = ?').get(id);
      let rec = {};
      try { rec = JSON.parse(row?.record_json ?? '{}'); } catch { rec = {}; }
      if (recordField) rec[recordField] = value;
      // keep runtime bookkeeping fields aligned too
      rec.updatedAtMs = updatedAtMs;
      db.prepare(
        `UPDATE local_runtime_sessions SET ${quoteIdent(column)} = ?, record_json = ?, updated_at_ms = ? WHERE session_id = ?`
      ).run(value, JSON.stringify(rec), updatedAtMs, id);
    });
    try {
      tx();
    } catch (e) {
      this._throwBusy(e);
    }
    const after = this.discovery.getSession(id);
    return { before: null, after };
  }

  _throwBusy(e) {
    const m = String(e.message || e);
    if (/SQLITE_BUSY|database is locked|is locked/i.test(m)) {
      throw new Error(`database is busy/locked (mcode may be writing); the transaction was rolled back and nothing was changed. Retry later. [${m}]`);
    }
    throw e;
  }

  rename(id, newTitle, { confirm = true } = {}) {
    this._requireExists(id);
    const before = this.discovery.getSession(id);
    const title = String(newTitle);
    if (!title.trim()) throw new Error('title must not be empty');
    if (before.title === title) return { unchanged: true, session: before };
    const res = this._updateColumn(id, 'title', title, 'title');
    this.log?.info(`renamed ${id}: ${JSON.stringify(before.title)} -> ${JSON.stringify(title)}`);
    return { before, after: res.after, changed: true };
  }

  setArchived(id, archived, { byKind } = {}) {
    this._requireExists(id);
    const before = this.discovery.getSession(id);
    const target = archived ? 1 : 0;
    if ((before.archived ? 1 : 0) === target) return { unchanged: true, session: before };
    const res = this._updateColumn(id, 'archived', target, 'archived');
    this.log?.info(`${archived ? 'archived' : 'unarchived'} ${id}`);
    return { before, after: res.after, changed: true };
  }

  // ---- fork: NATIVE path -------------------------------------------------
  async fork(id, { cwd } = {}) {
    this._requireExists(id);
    const src = this.discovery.getSession(id);
    // The runtime rejects a fork whose cwd differs from the source session's
    // persisted workspace ("Requested cwd does not match the persisted session
    // workspace"), so a fork cannot relocate a session. Surface that clearly.
    const ws = src.workspace_dir;
    if (cwd && cwd !== ws) {
      throw new Error(
        `a fork must stay in the source session's workspace: the source workspace is ${JSON.stringify(ws)} ` +
        `but ${JSON.stringify(cwd)} was requested. Omit --cwd to fork in place.`);
    }
    let result, newId;
    try {
      result = await withAcp(this.log, async acp => acp.forkSession({ sessionId: id, cwd: ws }));
      newId = result?.sessionId;
    } catch (e) {
      const msg = e?.error?.message || e.message;
      throw new Error(`native ACP session/fork failed: ${msg}. The tool will NOT fake a fork by copying rows; aborting.`);
    }
    if (!newId) throw new Error('native fork returned no sessionId; aborting');
    return { sourceSessionId: id, newSessionId: newId, session: this.discovery.getSession(newId), raw: result };
  }

  // ---- delete -------------------------------------------------------------
  // Steps follow the required workflow. Returns a report object.
  async delete(id, { dryRun = false, confirm = false, noBackup = false, onPlan, onConfirm } = {}) {
    this._requireExists(id);

    // 2) is it currently active?
    const { active, reasons } = this.safety.activeState(id);
    if (active) {
      return {
        refused: true, reason: 'session is currently active/running',
        detail: reasons, sessionId: id,
      };
    }

    // 4) dry-run plan
    const { entries, warnings } = this.safety.buildDeletePlan(id);
    const affecting = entries.filter(e => (e.count ?? 0) > 0);
    const report = {
      sessionId: id,
      dryRun,
      tablesAffected: affecting.length,
      rowsAffected: affecting.reduce((s, e) => s + e.count, 0),
      entries: affecting,
      warnings,
      plan: entries,
    };
    if (onPlan) await onPlan(report);

    if (dryRun) return { ...report, dryRun: true };

    // 6) explicit confirmation
    if (!confirm) {
      if (onConfirm) { const ok = await onConfirm(report); if (!ok) return { ...report, cancelled: true }; }
      else return { ...report, needsConfirm: true };
    }

    // 7) backup first (unless explicitly disabled)
    let backupPath = null;
    if (!noBackup) {
      try { backupPath = (await this.safety.backup({ label: 'pre-delete' })).path; }
      catch (e) { throw new Error(`backup failed, aborting delete (nothing removed): ${e.message}`); }
    }

    // Materialise cascade victims BEFORE the parent rows disappear: after the
    // primary row is gone the cascade subquery would match nothing, making a
    // post-hoc recount useless as a leftover check.
    let db = this.db.write();
    const cascadeProbes = [];
    for (const e of entries) {
      if (e.kind !== 'cascade' || !e.count || !e.idCol) continue;
      try {
        const rows = db.prepare(
          `SELECT ${quoteIdent(e.idCol)} v FROM ${quoteIdent(e.table)} WHERE ${e.where}`
        ).all(...e.params);
        if (rows.length) cascadeProbes.push({ table: e.table, idCol: e.idCol, ids: rows.map(r => r.v) });
      } catch (err) { this.log?.debug(`cascade probe failed on ${e.table}: ${err.message}`); }
    }

    // 8) perform transactionally
    let outcome = 'unknown';
    const removed = [];
    try {
      const tx = db.transaction(() => {
        for (const e of entries) {
          if (!e.count) continue;
          const r = db.prepare(`DELETE FROM ${quoteIdent(e.table)} WHERE ${e.where}`).run(...e.params);
          removed.push({ table: e.table, deleted: r.changes, expected: e.count });
          if (r.changes !== e.count) throw new Error(`row-count mismatch on ${e.table}: expected ${e.count}, deleted ${r.changes}`);
        }
      });
      tx();
      outcome = 'committed';
    } catch (e) {
      outcome = 'rolled-back';
      this.log?.error(`delete failed for ${id}: ${e.message}`);
      return { ...report, failed: true, outcome, error: this._describeError(e), backupPath };
    } finally {
      this.db.closeWrite();
      db = null;
    }

    // 9) verification — every planned table is re-counted; cascade children are
    //    checked by the concrete ids captured above, not by a dead subquery.
    const dependentCheck = [];
    for (const e of entries) {
      if (!e.count) continue;
      if (e.kind === 'cascade') continue; // handled via probes below
      const remaining = this.db.rowCount(e.table, e.where, e.params);
      dependentCheck.push({ table: e.table, remaining: remaining ?? 0 });
    }
    for (const probe of cascadeProbes) {
      let remaining = 0;
      for (let i = 0; i < probe.ids.length; i += CASCADE_PROBE_CHUNK) {
        const chunk = probe.ids.slice(i, i + CASCADE_PROBE_CHUNK);
        const ph = chunk.map(() => '?').join(',');
        remaining += this.db.rowCount(probe.table, `${quoteIdent(probe.idCol)} IN (${ph})`, chunk) ?? 0;
      }
      dependentCheck.push({ table: probe.table, remaining });
    }
    const stillThere = this.discovery.exists(id);
    return {
      ...report, committed: true, outcome, backupPath, removed,
      verified: !stillThere && dependentCheck.every(v => !v.remaining),
      sessionGone: !stillThere, dependentCheck,
    };
  }

  _describeError(e) {
    const m = String(e.message || e);
    if (/SQLITE_BUSY|database is locked/i.test(m)) return `database busy/locked; transaction rolled back, nothing removed. [${m}]`;
    return m;
  }
}
