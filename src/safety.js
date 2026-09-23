// Safety layer:
//  - detect whether a session is currently active/running
//  - build a dry-run deletion plan from the LIVE schema (no hardcoded table list)
//  - back up the database before a real destructive operation
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SqliteAdapter, quoteIdent, isSessionKeyCol, CASCADE_ID_COLS } from './sqlite.js';
import { MSM_BACKUP_DIR, DB_PATH } from './env.js';
import { betterSqlite } from './sqlite.js';

// Tables that are shared registries, not per-session data. Deleting a session
// must not remove them (conservative).
const SHARED_TABLES = new Set(['agents', 'local_runtime_projects', 'local_runtime_preferences']);

export function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { return existsSync(`/proc/${Number(pid)}`); } catch { return false; }
}

export class Safety {
  constructor({ log, db } = {}) {
    this.log = log;
    this.db = db ?? new SqliteAdapter({ log });
  }

  // Determine whether a session is currently active/running.
  // Returns { active: bool, reasons: string[] }
  activeState(sessionId) {
    const reasons = [];
    const r = this.db.read();
    // 1) an unexpired row in local_runtime_session_locks is authoritative
    try {
      const lock = r.prepare(
        `SELECT owner_id, owner_kind, acquired_at_ms, expires_at_ms
         FROM local_runtime_session_locks WHERE session_id = ?`
      ).get(sessionId);
      if (lock) {
        const now = Date.now();
        const expired = lock.expires_at_ms && lock.expires_at_ms < now;
        reasons.push(`session lock (owner_kind=${lock.owner_kind}, owner=${lock.owner_id}, expires=${lock.expires_at_ms}${expired ? ' [expired]' : ' [live]'})`);
        // try to extract a pid from the owner string, e.g. "turn-lease:28238:<uuid>"
        const m = /(\d{2,})/.exec(String(lock.owner_id ?? ''));
        if (m && pidAlive(m[1])) reasons.push(`owning pid ${m[1]} is alive (/proc/${m[1]})`);
        if (!expired) return { active: true, reasons };
      }
    } catch (e) { this.log?.debug(`lock check failed: ${e.message}`); }

    // 2) status column: 'started' means a turn is in flight
    try {
      const s = r.prepare('SELECT status FROM local_runtime_sessions WHERE session_id = ?').get(sessionId);
      if (s && s.status === 'started') reasons.push(`status='${s.status}' (a turn is in flight)`);
      if (s && s.status === 'started') return { active: true, reasons };
    } catch (e) { this.log?.debug(`status check failed: ${e.message}`); }

    // 3) agents registry: an agent whose main session this is and is alive
    try {
      const a = r.prepare('SELECT agent_name, pid, process_alive FROM agents WHERE main_session_id = ?').get(sessionId);
      if (a) {
        reasons.push(`registered as main_session_id of agent '${a.agent_name}' (pid=${a.pid}, process_alive=${a.process_alive})`);
        if (a.process_alive === 1 || pidAlive(a.pid)) return { active: true, reasons };
      }
    } catch (e) { this.log?.debug(`agents check failed: ${e.message}`); }

    const active = reasons.some(x => /\[live\]|alive|in flight/.test(x));
    return { active, reasons };
  }

  // primary-key columns of a table (delegated to the adapter)
  pk(table) { return this.db.pk(table); }

  // fts5 shadow tables must be excluded; we delete from the fts table itself.
  _ftsShadowNames() {
    const set = new Set();
    for (const t of this.db.tables()) {
      const sql = this.db.read().prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(t)?.sql ?? '';
      if (/USING fts/i.test(sql)) {
        for (const suf of ['content', 'data', 'idx', 'docsize', 'config']) set.add(`${t}_${suf}`);
      }
    }
    return set;
  }

  // Build a deletion plan from the live schema. Every entry targets the exact
  // session id only. Returns { entries: [{table, kind, where, params, count}], warnings }
  buildDeletePlan(sessionId) {
    const entries = [];
    const warnings = [];
    const shadows = this._ftsShadowNames();
    const tables = this.db.tables().filter(t => !shadows.has(t) && !SHARED_TABLES.has(t));

    const sessionKeyed = tables.filter(t => this.db.columns(t).some(isSessionKeyCol));

    // 1) direct session-key tables
    for (const t of sessionKeyed) {
      const cols = this.db.columns(t).filter(isSessionKeyCol);
      const where = cols.map(c => `${quoteIdent(c)} = ?`).join(' OR ');
      entries.push({ table: t, kind: t === 'local_runtime_sessions' ? 'primary' : 'session_key', where, params: cols.map(() => sessionId), count: null });
    }

    // 2) cascade children: tables with no session key but a whitelisted id column.
    //    The parent must OWN that id (it is part of the parent's PRIMARY KEY) so we
    //    only ever delete children of rows we are definitely removing. This matters
    //    because a fork shares turn ids with its source: cascading via
    //    turn_diffs/token_usage (which merely *have* a turn_id) could delete another
    //    session's rows. turn_ingress (PK=turn_id) / background_tasks (PK=task_id)
    //    are the authoritative owners.
    for (const t of tables) {
      if (sessionKeyed.includes(t)) continue;
      const cols = this.db.columns(t).filter(c => CASCADE_ID_COLS.includes(c));
      for (const c of cols) {
        const parent = sessionKeyed.find(p => p !== t && this.db.columns(p).includes(c) && this.pk(p).includes(c));
        if (!parent) continue;
        const pcols = this.db.columns(parent).filter(isSessionKeyCol);
        const pwhere = pcols.map(pc => `${quoteIdent(pc)} = ?`).join(' OR ');
        entries.push({
          table: t, kind: 'cascade',
          where: `${quoteIdent(c)} IN (SELECT ${quoteIdent(c)} FROM ${quoteIdent(parent)} WHERE ${pwhere})`,
          params: pcols.map(() => sessionId),
          count: null,
        });
      }
    }

    // 3) dangling references in shared registries (reported, NOT deleted)
    try {
      const a = this.db.read().prepare('SELECT agent_name, main_session_id FROM agents WHERE main_session_id = ?').get(sessionId);
      if (a) warnings.push(`agents.main_session_id of agent '${a.agent_name}' will dangle (left untouched; it is a shared registry row)`);
    } catch {}

    // fill counts
    for (const e of entries) e.count = this.db.rowCount(e.table, e.where, e.params);

    // children first, primary row last; keep a stable order otherwise
    entries.sort((a, b) => (a.kind === 'primary' ? 1 : 0) - (b.kind === 'primary' ? 1 : 0));
    return { entries, warnings };
  }

  // Online backup via SQLite's backup API. Never touches the live DB.
  async backup({ label = 'pre-delete' } = {}) {
    mkdirSync(MSM_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '');
    const dest = path.join(MSM_BACKUP_DIR, `runtime-state-${stamp}-${label}.sqlite`);
    const D = betterSqlite();
    const src = new D(DB_PATH, { readonly: true, fileMustExist: true });
    try {
      await src.backup(dest);
      this.log?.info(`database backed up to ${dest}`);
      return { path: dest };
    } finally {
      try { src.close(); } catch {}
    }
  }
}
