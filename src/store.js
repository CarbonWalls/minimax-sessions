// Session STORE index for the mcode 0.5.5 file layout.
//
// mcode 0.5.5 persists sessions as a dated directory tree:
//   <SESSIONS_DIR>/YYYY/MM/DD/HH-MM-SS-mmm-session_<base64(sessionId)>/
//     manifest.json            schemaVersion, sessionId, createdAtMs, paths
//     history-catalog.json     generation/revision, messageCount, byteLength
//     messages.jsonl           the authoritative record stream
//     user-message-locators.jsonl, llm-call.json, snapshots/, reports/
//
// The list is built from CHEAP metadata only. Building the index is a pure
// readdir walk: the directory name encodes the session id (base64 of the mvs_
// id) and the creation timestamp, so the index needs no file reads at all to
// exist or to sort. Every per-session fact (size, mtime, record count, the
// derived name) is read LAZILY on first access and cached on the entry, so a
// list of thousands of sessions costs almost nothing and only the rows
// actually displayed ever touch the filesystem. messages.jsonl is parsed only
// when a session is selected (src/jsonl.js).
//
// Rows are the UNION of the file store and the runtime SQLite database (which
// still holds the authoritative *title*, status, parent and kind for the
// sessions it currently indexes). File-store-only sessions — older ones the
// runtime has dropped from its index — still appear, with a derived name.
// Every read is read-only; nothing under SESSIONS_DIR is ever written.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from './env.js';
import { readFirstLine, firstUserText, deriveName } from './jsonl.js';

const DIR_SUFFIX = '-session_';
const POOL = 24; // concurrent per-entry reads while warming a window

// One session directory. All IO is lazy and memoised here.
export class SessionEntry {
  constructor({ dir, dirName }) {
    this.dir = dir;
    this.dirName = dirName;
    // the directory suffix is base64 of the mvs_ id — decode it now; it is
    // cheap and needs no file access. The manifest can override if it
    // disagrees (it is authoritative), checked on first load.
    this.sessionId = decodeSessionId(dirName) || dirName;
    this._loaded = false;
    this._name = null;
    this.db = null;
  }

  // ---- cheap derived from the path alone -------------------------------
  // .../2026/09/25/23-11-16-964-session_...  ->  1790377876964-ish ordering
  get createdAtMs() { return this._createdAtMs ?? (this._createdAtMs = dirToMs(this.dir)) ?? null; }
  get isBranch() { return !!this._isBranch; }

  // ---- lazy IO ----------------------------------------------------------
  load() {
    if (this._loaded) return this;
    this._loaded = true;
    this._manifest = null;
    this._catalog = null;
    this._sidecars = [];
    this._messagesPath = null;
    this._messagesSize = 0;
    this._messagesMtimeMs = null;
    this._firstUserText = null;
    this._summary = null;
    this._inferredParent = null;
    this._inferredCwd = null;
    this._isBranch = false;
    this._firstLineTruncated = false;
    try { this._sidecars = readdirSync(this.dir).filter(n => n !== 'messages.jsonl'); } catch { /* dir gone */ }
    const mp = path.join(this.dir, 'messages.jsonl');
    if (existsSync(mp)) {
      this._messagesPath = mp;
      try {
        const st = statSync(mp);
        this._messagesSize = st.size;
        this._messagesMtimeMs = st.mtimeMs;
      } catch { /* unreadable: keep zeros */ }
    }
    try { this._manifest = JSON.parse(readFileSync(path.join(this.dir, 'manifest.json'), 'utf8')); } catch { /* optional */ }
    try { this._catalog = JSON.parse(readFileSync(path.join(this.dir, 'history-catalog.json'), 'utf8')); } catch { /* optional */ }
    // the manifest is authoritative for the id when it is present
    if (this._manifest?.sessionId) this.sessionId = this._manifest.sessionId;
    return this;
  }

  // ensure the lazily-read name + relations are available
  async populate() {
    this.load();
    if (this._populated) return this;
    this._populated = true;
    if (!this._messagesPath) return this;
    const { line, truncated } = await readFirstLine(this._messagesPath);
    this._firstLineTruncated = truncated;
    if (truncated) return this; // live/huge first line: do not guess
    let o = null;
    try { o = JSON.parse(line); } catch { return this; }
    this._firstUserText = firstUserText(o?.message) ?? o?.message?.genuineUserQueryText ?? null;
    const t = o?.message?.content?.[0]?.text ?? '';
    const m = /PARENT SESSION:\s*(mvs_[0-9a-f]+)/.exec(String(t));
    if (m) { this._inferredParent = m[1]; this._isBranch = true; }
    const role = /SESSION ROLE:\s*(\w+)/.exec(String(t));
    if (role && /branch|subagent|task/i.test(role[1])) this._isBranch = true;
    if (!this._firstUserText) this._summary = await peekSummary(this._messagesPath);
    return this;
  }

  // ---- accessors (all read-only) ---------------------------------------
  get messagesPath() { return this.load()._messagesPath; }
  get messagesSize() { return this.load()._messagesSize; }
  get messagesMtimeMs() { return this.load()._messagesMtimeMs; }
  get hasMessages() { return this.messagesSize > 0; }
  get sidecars() { return this.load()._sidecars; }
  get hasReports() { return this.load()._sidecars.includes('reports'); }
  get hasSnapshots() { return this.load()._sidecars.includes('snapshots'); }
  get hasLlmCall() { return this.load()._sidecars.includes('llm-call.json'); }
  get manifest() { return this.load()._manifest; }
  get catalog() { return this.load()._catalog; }
  get mcodeLayout() { return this.manifest?.layout ?? null; }
  get activeGeneration() { return this.catalog?.activeGeneration ?? null; }
  get activeRevision() { return this.catalog?.activeRevision ?? null; }
  get catalogCount() {
    const arts = this.catalog?.artifacts;
    return arts?.find(a => a.kind === 'active')?.messageCount ?? arts?.[0]?.messageCount ?? null;
  }
  // newest known activity: runtime's updated_at, the manifest, or the file
  get updatedAtMs() {
    this.load();
    const c = [this._manifest?.updatedAtMs, this.db?.updated_at_ms, this._messagesMtimeMs].filter(Number.isFinite);
    return c.length ? Math.max(...c) : null;
  }
  get storedTitle() { return this.db?.title ?? null; }
  get status() { return this.db?.status ?? null; }
  get archived() { return !!this.db?.archived; }
  get sessionKind() { return this.db?.session_kind ?? (this.isBranch ? 'task' : null); }
  get workspaceDir() { return this.db?.workspace_dir ?? this._inferredCwd ?? null; }
  get parentId() { return this.db?.parent_session_id ?? this._inferredParent ?? null; }

  // derived name, computed once and cached. NEVER written anywhere.
  async nameInfo() {
    if (this._name) return this._name;
    await this.populate();
    this._name = deriveName({
      storedTitle: this.storedTitle,
      firstUserText: this._firstUserText,
      summary: this._summary,
      cwd: this.workspaceDir,
      dirName: this.dirName,
      createdAtMs: this.createdAtMs,
    });
    this._name.firstLineTruncated = !!this._firstLineTruncated;
    return this._name;
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      dir: this.dir,
      dirName: this.dirName,
      createdAtMs: this.createdAtMs,
      updatedAtMs: this.updatedAtMs,
      messagesSize: this.messagesSize,
      messagesMtimeMs: this.messagesMtimeMs,
      hasMessages: this.hasMessages,
      catalogCount: this.catalogCount,
      activeGeneration: this.activeGeneration,
      activeRevision: this.activeRevision,
      sidecars: this.sidecars,
      layout: this.mcodeLayout,
      storedTitle: this.storedTitle,
      status: this.status,
      archived: this.archived,
      sessionKind: this.sessionKind,
      workspaceDir: this.workspaceDir,
      parentId: this.parentId,
      inDatabase: !!this.db,
    };
  }
}

// .../2026/09/25/23-11-16-964-... -> ms timestamp (best effort; the directory
// is mcode's own creation stamp so it is trustworthy for ordering)
function dirToMs(dir) {
  const m = /(\d{4})[/-](\d{2})[/-](\d{2})[/-](\d{2})-(\d{2})-(\d{2})(?:[.-](\d{1,3}))?/.exec(String(dir));
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const n = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +(ms ?? 0));
  return Number.isFinite(n) ? n : null;
}

function decodeSessionId(dirName) {
  const marker = String(dirName).indexOf(DIR_SUFFIX);
  if (marker < 0) return null;
  try {
    const d = Buffer.from(String(dirName).slice(marker + DIR_SUFFIX.length), 'base64').toString('utf8');
    return /^mvs_[0-9a-f]{32}$/.test(d) ? d : null;
  } catch { return null; }
}

// Peek the first ~16 lines for a compactionSummary (a stored summary mcode
// writes when it compacts history). Bounded; never parses the whole file.
async function peekSummary(messagesPath, maxLines = 16) {
  let fh;
  try {
    const { open } = await import('node:fs/promises');
    fh = await open(messagesPath, 'r');
    const buf = Buffer.alloc(1 << 17);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, maxLines);
    for (const l of lines) {
      if (!l) continue;
      try {
        const o = JSON.parse(l);
        if (o?.message?.role === 'compactionSummary' && o.message.summary) return o.message.summary;
      } catch { /* keep scanning */ }
    }
  } catch { /* ignore */ } finally { try { await fh?.close(); } catch {} }
  return null;
}

export class StoreIndex {
  constructor({ log, db = null, sessionsDir = SESSIONS_DIR } = {}) {
    this.log = log;
    this.db = db; // optional SqliteAdapter for enrichment (title/status/parent)
    this.sessionsDir = sessionsDir;
    this._entries = null;
    this._byId = null;
    this._enriched = false;
  }

  get dir() { return this.sessionsDir; }
  available() { return existsSync(this.sessionsDir); }

  // pure readdir walk; no file is opened, so this stays fast at any scale.
  // newest first: the dated path sorts chronologically.
  build() {
    const entries = [];
    if (existsSync(this.sessionsDir)) {
      for (const y of sortedDirs(this.sessionsDir)) {
        for (const mo of sortedDirs(y)) {
          for (const day of sortedDirs(mo)) {
            for (const d of sortedDirs(day)) entries.push(new SessionEntry({ dir: d, dirName: path.basename(d) }));
          }
        }
      }
    }
    entries.sort((a, b) => b.dir.localeCompare(a.dir));
    this._entries = entries;
    this._byId = null;
    this._enriched = false;
    return entries;
  }

  // merge SQLite rows in (title/status/kind/workspace/parent). One query, one
  // pass; sessions absent from the DB keep their derived values.
  enrich(entries = this.entries()) {
    if (this._enriched || !this.db) return entries;
    this._enriched = true;
    let rows = [];
    try {
      rows = this.db.read().prepare(
        'SELECT session_id, title, status, archived, session_kind, runtime,' +
        ' agent_name, workspace_dir, project_workspace_dir, parent_session_id,' +
        ' created_at_ms, updated_at_ms, visibility, purpose, session_type,' +
        ' error_message FROM local_runtime_sessions'
      ).all();
    } catch (e) { this.log?.warn(`store enrich: sqlite unavailable: ${e.message}`); return entries; }
    const byId = new Map(rows.map(r => [r.session_id, r]));
    for (const e of entries) if (byId.has(e.sessionId)) e.db = byId.get(e.sessionId);
    return entries;
  }

  entries() { if (this._entries == null) this.build(); return this._entries; }
  byId(id) {
    if (this._byId == null) {
      // build into a local first: entries()/build() reset _byId, so assigning
      // before iterating would leave a null map mid-construction
      const m = new Map();
      for (const e of this.entries()) if (!m.has(e.sessionId)) m.set(e.sessionId, e);
      this._byId = m;
    }
    return this._byId.get(id) ?? null;
  }

  // resolve any of: exact mvs_ id | session directory name | absolute dir path |
  // absolute messages.jsonl path
  resolve(ref) {
    if (!ref) return null;
    const s = String(ref).trim();
    if (this.byId(s)) return this.byId(s);
    const p = s.endsWith('/messages.jsonl') ? path.dirname(s) : s;
    if (existsSync(p) && path.basename(p).includes(DIR_SUFFIX)) return this._entryForDir(p);
    // maybe a bare directory name; search the index
    const hit = this.entries().find(e => e.dirName === s || e.dirName === path.basename(s));
    return hit ?? null;
  }
  _entryForDir(dir) {
    const cached = this.entries().find(e => e.dir === dir);
    return cached ?? new SessionEntry({ dir, dirName: path.basename(dir) });
  }

  // cheap facet counts for the browser header: total comes from the walk and
  // inDatabase/archived from the enrichment — neither opens a file. Counting
  // non-empty sessions needs a stat per entry, so that is a separate async
  // pass (warmFacets) that the UI can run after the first frame.
  facetCounts(entries = this.entries()) {
    let inDatabase = 0, archived = 0;
    for (const e of entries) {
      if (e.db) { inDatabase++; if (e.archived) archived++; }
    }
    return { total: entries.length, inDatabase, archived };
  }

  // count sessions that actually have a non-empty messages.jsonl, warming the
  // per-entry loads in parallel. Safe to run in the background.
  async warmFacets(entries = this.entries()) {
    let withMessages = 0;
    await preload(entries, e => { if (e.messagesSize > 0) withMessages++; });
    return withMessages;
  }
}

// Run `fn(entry)` over a list with a bounded concurrency so warming a window
// of rows stays responsive even on slow filesystems.
export async function preload(entries, fn, concurrency = POOL) {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= entries.length) return;
      try { await fn(entries[i]); } catch { /* keep warming the rest */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
}

function sortedDirs(p) {
  let out = [];
  try {
    out = readdirSync(p, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(p, d.name));
  } catch { /* missing date level */ }
  return out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}
