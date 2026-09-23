// SQLite adapter.
// - reads open the DB read-only (fileMustExist)
// - writes use a short-lived read/write connection with busy_timeout
// - the better-sqlite3 native binding is loaded from the mcode installation so
//   this tool has zero npm dependencies of its own
import { createRequire } from 'node:module';
import { MCODE_CLI_JS, DB_PATH } from './env.js';

let _better = null;
export function betterSqlite() {
  if (_better) return _better;
  const req = createRequire(MCODE_CLI_JS);
  _better = req('better-sqlite3');
  return _better;
}

export class SqliteAdapter {
  constructor({ log } = {}) { this.log = log; this._ro = null; this._rw = null; }

  // ---- read-only connection (all discovery/inspect/stats/export) ----
  read() {
    if (!this._ro) {
      const D = betterSqlite();
      this._ro = new D(DB_PATH, { readonly: true, fileMustExist: true });
      // no journal_mode write here: the connection is read-only; the DB is
      // already in WAL (mcode opens it that way) and a PRAGMA that mutates
      // would fail on a truly immutable file.
      this._ro.pragma('foreign_keys = OFF');
      this._ro.pragma('busy_timeout = 5000');
    }
    return this._ro;
  }

  // short-lived writer; caller must close via closeWrite()
  write() {
    if (!this._rw) {
      const D = betterSqlite();
      this._rw = new D(DB_PATH, { fileMustExist: true });
      this._rw.pragma('foreign_keys = OFF');
      this._rw.pragma('busy_timeout = 8000');
      this._rw.pragma('journal_mode = WAL');
    }
    return this._rw;
  }

  closeWrite() {
    if (this._rw) { try { this._rw.close(); } catch { /* already closed */ } this._rw = null; }
  }
  close() { this.closeWrite(); if (this._ro) { try { this._ro.close(); } catch { /* already closed */ } this._ro = null; } }

  // ---------- schema introspection (never hardcode) ----------
  tables() {
    return this.read().prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).all().map(r => r.name);
  }

  columns(table) {
    return this.read().prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(r => r.name);
  }

  // primary-key column names for a table (empty for tables without a pk)
  pk(table) {
    return this.read().prepare(`PRAGMA table_info(${quoteIdent(table)})`).all()
      .filter(r => r.pk > 0).map(r => r.name);
  }

  // every table that carries a direct session-key column
  tablesWithSessionKey() {
    return this.tables().filter(t => this.columns(t).some(isSessionKeyCol));
  }

  rowCount(table, where, params) {
    const sql = `SELECT count(*) AS n FROM ${quoteIdent(table)} WHERE ${where}`;
    try { return this.read().prepare(sql).get(...(params ?? [])).n; }
    catch (e) { this.log?.debug(`count failed on ${table}: ${e.message}`); return null; }
  }
}

// A column references a session if it is `session_id` or ends with `_session_id`
// or is one of the known *_session reference spellings used by this schema.
export function isSessionKeyCol(col) {
  return col === 'session_id'
    || /_session_id$/.test(col)
    || ['from_session', 'to_session', 'owner_session'].includes(col);
}

export function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

// whitelist of id columns we are willing to cascade through when the parent
// table is itself session-keyed (keeps us from ever touching e.g. project_id)
export const CASCADE_ID_COLS = ['turn_id', 'task_id', 'msg_id', 'message_id', 'change_set_id'];
