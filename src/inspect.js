// Inspect / stats / export. All read-only.
import { Discovery } from './discovery.js';

export class Inspector {
  constructor({ log, db } = {}) {
    this.log = log;
    this.d = new Discovery({ log, db });
  }

  inspect(id) {
    const s = this.d.getSession(id);
    if (!s) throw new Error(`session not found: ${id}`);
    const msgs = this.d.messageCount(id);
    const usage = this.d.tokenUsage(id);
    const children = this.d.childCount(id);
    const locks = this.d.db.read().prepare(
      `SELECT owner_id, owner_kind, acquired_at_ms, expires_at_ms FROM local_runtime_session_locks WHERE session_id = ?`
    ).all(id);
    return { session: s, messageCount: msgs, tokenUsage: usage, childSessionCount: children, locks };
  }

  stats(id) {
    const s = this.d.getSession(id);
    if (!s) throw new Error(`session not found: ${id}`);
    const usage = this.d.tokenUsage(id);
    const byRole = this.d.messageCountByRole(id);
    const turns = this.d.db.read().prepare('SELECT count(*) n FROM local_runtime_turn_ingress WHERE session_id = ?').get(id).n;
    const diffs = this.d.db.read().prepare('SELECT count(*) n FROM local_runtime_turn_diffs WHERE session_id = ?').get(id).n;
    const approx = this.d.approxRowCount(id);
    const last = this.d.lastActivityMs(id);
    return { sessionId: id, title: s.title, status: s.status, archived: !!s.archived,
             messageCount: byRole.reduce((a, r) => a + r.n, 0), messagesByRole: byRole,
             turnCount: turns, turnDiffCount: diffs,
             tokenUsage: usage, approxDbRows: approx, lastActivityMs: last };
  }

  export(id, { format = 'markdown' } = {}) {
    const s = this.d.getSession(id);
    if (!s) throw new Error(`session not found: ${id}`);
    const msgs = this.d.messages(id, { limit: 100000 });
    const meta = { ...s };
    if (format === 'json') {
      return {
        meta,
        messages: msgs.map(m => {
          let data = null;
          try { data = JSON.parse(m.data_json); } catch { data = { raw: m.data_json }; }
          return { msg_id: m.msg_id, role: m.role, turn_id: m.turn_id, created_at_ms: m.created_at_ms, source: m.source, data };
        }),
      };
    }
    if (format === 'metadata') return meta;
    // markdown
    const lines = [];
    lines.push(`# Session ${s.session_id}`);
    lines.push('');
    lines.push(`- title: ${s.title ?? '(none)'}`);
    lines.push(`- status: ${s.status}${s.archived ? ' (archived)' : ''}`);
    lines.push(`- kind: ${s.session_kind} / runtime ${s.runtime} / agent ${s.agent_name}`);
    lines.push(`- workspace: ${s.workspace_dir}`);
    if (s.parent_session_id) lines.push(`- parent: ${s.parent_session_id}`);
    lines.push(`- created: ${iso(s.created_at_ms)}  updated: ${iso(s.updated_at_ms)}`);
    lines.push('');
    lines.push('## Conversation');
    lines.push('');
    for (const m of msgs) {
      let data = null;
      try { data = JSON.parse(m.data_json); } catch { data = { msg_content: String(m.data_json).slice(0, 200) }; }
      const role = m.role || (data?.role ?? 'unknown');
      const content = data?.msg_content ?? data?.content ?? '';
      const files = Array.isArray(data?.files) ? data.files : null;
      lines.push(`### ${role} — ${iso(m.created_at_ms)}`);
      lines.push('');
      if (content) lines.push(String(content));
      if (files && files.length) { lines.push(''); lines.push('_attachments: ' + files.map(f => f.name ?? f.path ?? f).join(', ') + '_'); }
      lines.push('');
    }
    return lines.join('\n');
  }
}

function iso(ms) {
  if (ms == null) return '?';
  const n = Number(ms);
  if (!Number.isFinite(n)) return '?';
  try { return new Date(n).toISOString(); } catch { return String(n); }
}
