// Session discovery. Rich listing columns come from read-only SQLite
// (the ACP session/list cannot return status/archived/kind/workspace/age).
// Existence can optionally be cross-checked against the native ACP list.
import { SqliteAdapter, isSessionKeyCol } from './sqlite.js';
import { withAcp } from './acp.js';
import { escapeLike } from './format.js';

// Preferred columns; only ones that actually exist in the live schema are
// selected, so a future mcode schema change degrades instead of throwing.
const PREFERRED_COLS = [
  'session_id', 'title', 'status', 'archived', 'session_kind', 'runtime',
  'agent_name', 'workspace_dir', 'project_workspace_dir', 'parent_session_id',
  'created_at_ms', 'updated_at_ms', 'visibility', 'purpose', 'session_type',
  'error_message', 'project_id', 'extra_data_json',
];

export class Discovery {
  constructor({ log, db } = {}) {
    this.log = log;
    this.db = db ?? new SqliteAdapter({ log });
    this._cols = null;
  }

  _sessionCols() {
    if (this._cols) return this._cols;
    let have;
    try { have = new Set(this.db.columns('local_runtime_sessions')); }
    catch { have = new Set(PREFERRED_COLS); }
    this._cols = PREFERRED_COLS.filter(c => have.has(c));
    if (!this._cols.includes('session_id')) this._cols.unshift('session_id');
    return this._cols;
  }

  // total count is cheap: one indexed count
  totalCount() { return this.db.read().prepare('SELECT count(*) n FROM local_runtime_sessions').get().n; }

  // counts by status/archived, cheap
  facetCounts() {
    const r = this.db.read();
    return {
      archived: r.prepare("SELECT count(*) n FROM local_runtime_sessions WHERE archived=1").get().n,
      active: r.prepare('SELECT count(*) n FROM local_runtime_session_locks').get().n,
    };
  }

  list({ limit = 50, offset = 0, filters = {} } = {}) {
    const where = [];
    const params = [];
    const f = filters;
    if (f.q) {
      // literal match on title/purpose + exact id; LIKE wildcards in the query
      // are escaped so "100%" does not mean "100" + anything.
      const like = '%' + escapeLike(String(f.q).toLowerCase()) + '%';
      const parts = [`LOWER(title) LIKE ? ESCAPE '\\'`];
      params.push(like);
      if (this._sessionCols().includes('purpose')) {
        parts.push(`LOWER(purpose) LIKE ? ESCAPE '\\'`);
        params.push(like);
      }
      parts.push('session_id = ?');
      params.push(f.q);
      where.push('(' + parts.join(' OR ') + ')');
    }
    if (f.archived === 'only') { where.push('archived = 1'); }
    else if (f.archived === 'exclude') { where.push('archived = 0'); }
    if (f.status) { where.push('status = ?'); params.push(f.status); }
    if (f.kind) { where.push('session_kind = ?'); params.push(f.kind); }
    if (f.workspace) { where.push('workspace_dir = ?'); params.push(f.workspace); }
    if (f.parent) { where.push('parent_session_id = ?'); params.push(f.parent); }

    const cols = this._sessionCols().join(', ');
    const sql = `SELECT ${cols}
                 FROM local_runtime_sessions
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY updated_at_ms DESC, session_id ASC
                 LIMIT ? OFFSET ?`;
    const rows = this.db.read().prepare(sql).all(...params, limit, offset);
    // total for the *filtered* set (cheap, single count)
    const csql = `SELECT count(*) n FROM local_runtime_sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const total = this.db.read().prepare(csql).get(...params).n;
    return { rows, total };
  }

  // optional full-text pass over message bodies (slower; opt-in via --messages)
  searchMessages(q, { limit = 200 } = {}) {
    const like = '%' + escapeLike(String(q ?? '')) + '%';
    return this.db.read().prepare(
      `SELECT DISTINCT session_id FROM local_runtime_message_rows
       WHERE data_json LIKE ? ESCAPE '\\' LIMIT ?`
    ).all(like, limit).map(r => r.session_id);
  }

  workspaces() {
    return this.db.read().prepare(
      `SELECT workspace_dir, count(*) n FROM local_runtime_sessions
       WHERE workspace_dir IS NOT NULL GROUP BY workspace_dir ORDER BY n DESC`
    ).all();
  }
  statuses() {
    return this.db.read().prepare('SELECT status, count(*) n FROM local_runtime_sessions GROUP BY status ORDER BY n DESC').all();
  }
  kinds() {
    return this.db.read().prepare('SELECT session_kind, count(*) n FROM local_runtime_sessions GROUP BY session_kind ORDER BY n DESC').all();
  }

  getSession(id) {
    return this.db.read().prepare(`SELECT ${this._sessionCols().join(', ')} FROM local_runtime_sessions WHERE session_id = ?`).get(id) ?? null;
  }
  exists(id) {
    return this.db.read().prepare('SELECT 1 FROM local_runtime_sessions WHERE session_id = ?').get(id) !== undefined;
  }

  childCount(id) {
    return this.db.read().prepare('SELECT count(*) n FROM local_runtime_sessions WHERE parent_session_id = ?').get(id).n;
  }

  messageCount(id) {
    return this.db.read().prepare('SELECT count(*) n FROM local_runtime_message_rows WHERE session_id = ?').get(id).n;
  }
  messageCountByRole(id) {
    return this.db.read().prepare(
      'SELECT role, count(*) n FROM local_runtime_message_rows WHERE session_id = ? GROUP BY role'
    ).all(id);
  }
  // last activity across the session's own row and its message rows
  lastActivityMs(id) {
    const r = this.db.read().prepare(
      `SELECT MAX(t) m FROM (SELECT updated_at_ms t FROM local_runtime_sessions WHERE session_id=?
        UNION ALL SELECT created_at_ms FROM local_runtime_message_rows WHERE session_id=?
        UNION ALL SELECT ts FROM local_runtime_token_usage WHERE session_id=?)`
    ).get(id, id, id);
    return r?.m ?? null;
  }

  tokenUsage(id) {
    return this.db.read().prepare(
      `SELECT count(*) rows,
              COALESCE(SUM(input_tokens),0) input,
              COALESCE(SUM(output_tokens),0) output,
              COALESCE(SUM(reasoning_tokens),0) reasoning,
              COALESCE(SUM(cache_read_tokens),0) cache_read,
              COALESCE(SUM(cache_write_tokens),0) cache_write,
              COALESCE(SUM(cost_usd),0) cost
       FROM local_runtime_token_usage WHERE session_id = ?`
    ).get(id);
  }

  // approximate number of db rows that belong to this session (all session-keyed tables)
  approxRowCount(id) {
    let total = 0; const per = {};
    for (const t of this.db.tablesWithSessionKey()) {
      const keys = this.db.columns(t).filter(isSessionKeyCol);
      if (!keys.length) continue;
      const where = keys.map(k => `"${String(k).replace(/"/g, '""')}" = ?`).join(' OR ');
      const n = this.db.read().prepare(`SELECT count(*) n FROM "${String(t).replace(/"/g, '""')}" WHERE ${where}`).get(...keys.map(() => id)).n;
      per[t] = n; total += n;
    }
    return { total, per };
  }

  messages(id, { limit = 5000, offset = 0 } = {}) {
    return this.db.read().prepare(
      `SELECT msg_id, role, turn_id, created_at_ms, data_json, source
       FROM local_runtime_message_rows WHERE session_id = ?
       ORDER BY created_at_ms ASC, id ASC LIMIT ? OFFSET ?`
    ).all(id, limit, offset);
  }

  // native ACP list (used to corroborate ids against the live runtime)
  async nativeList({ cwd, cursor } = {}) {
    try {
      return await withAcp(this.log, async acp => acp.listSessions({ cwd, cursor }));
    } catch (e) { this.log?.warn(`native ACP list unavailable: ${e.message}`); return null; }
  }
}
