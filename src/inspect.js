// Inspect / stats / export. All read-only.
import { Discovery } from './discovery.js';
import { iso } from './format.js';

export const EXPORT_FORMATS = ['markdown', 'json', 'jsonl', 'metadata'];

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
      'SELECT owner_id, owner_kind, acquired_at_ms, expires_at_ms FROM local_runtime_session_locks WHERE session_id = ?'
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
    return {
      sessionId: id, title: s.title, status: s.status, archived: !!s.archived,
      messageCount: byRole.reduce((a, r) => a + r.n, 0), messagesByRole: byRole,
      turnCount: turns, turnDiffCount: diffs,
      tokenUsage: usage, approxDbRows: approx, lastActivityMs: last,
    };
  }

  export(id, { format = 'markdown' } = {}) {
    if (!EXPORT_FORMATS.includes(format)) {
      throw new Error(`unknown export format: ${format} (use ${EXPORT_FORMATS.join('|')})`);
    }
    const s = this.d.getSession(id);
    if (!s) throw new Error(`session not found: ${id}`);
    const msgs = this.d.messages(id, { limit: 100000 });
    const meta = { ...s };
    const parse = m => {
      try { return JSON.parse(m.data_json); } catch { return { raw: m.data_json }; }
    };
    if (format === 'json') {
      return {
        meta,
        messages: msgs.map(m => ({
          msg_id: m.msg_id, role: m.role, turn_id: m.turn_id,
          created_at_ms: m.created_at_ms, source: m.source, data: parse(m),
        })),
      };
    }
    if (format === 'jsonl') {
      const lines = [JSON.stringify({ type: 'meta', ...meta })];
      for (const m of msgs) {
        lines.push(JSON.stringify({
          type: 'message', msg_id: m.msg_id, role: m.role, turn_id: m.turn_id,
          created_at_ms: m.created_at_ms, source: m.source, data: parse(m),
        }));
      }
      return lines.join('\n') + '\n';
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
      const data = parse(m);
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
