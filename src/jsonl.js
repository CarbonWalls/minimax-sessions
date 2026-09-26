// mcode 0.5.5 session-record parser.
//
// The authoritative source is the raw messages.jsonl. This module never
// normalises, completes, or rewrites a record: every parsed record keeps a
// pointer to its exact source text and to the object JSON.parse produced, so
// unknown and future fields survive every export and every view unchanged.
//
// Record shape observed in real 0.5.5 files:
//   { message_id, turn_id, message: { role, content: [ blocks ], ... },
//     history_artifact? }
// roles seen: user | assistant | toolResult | custom | compactionSummary
// block types seen: text | thinking | toolCall
// assistant toolCall:   { type:'toolCall', id, name, arguments }
// toolResult message:   { role:'toolResult', toolCallId, toolName, content,
//                         details, isError }
//
// Anything outside these known sets is REPORTED, never dropped.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

// Closed over what 0.5.5 actually emits today: a new field/role from a future
// mcode release is flagged "unknown" instead of being silently consumed.
export const KNOWN_ROLES = new Set(['user', 'assistant', 'toolResult', 'custom', 'compactionSummary']);
export const KNOWN_BLOCK_TYPES = new Set(['text', 'thinking', 'toolCall']);
export const KNOWN_TOP_KEYS = new Set(['message_id', 'turn_id', 'message', 'history_artifact']);
export const KNOWN_MESSAGE_KEYS = new Set([
  'role', 'content', 'timestamp', 'canonicalTextRange', 'api', 'provider', 'model',
  'usage', 'stopReason', 'responseId', 'responseModel',
  'toolCallId', 'toolName', 'details', 'isError',
  'customType', 'display', 'hostMetadata', 'summary', 'tokensBefore',
  'genuineUserQueryText',
]);
export const KNOWN_DETAIL_KEYS = new Set([
  'execution', 'timing', 'output', 'processOutput', 'description', 'is_error',
  'textFile', 'diff', 'patch', 'firstChangedLine', 'files', 'matches', 'status',
  'envSanitized',
  'task_id', 'matched', 'limit', 'offset', 'total', 'next_offset', 'truncated',
  'timed_out', 'effective_wait_ms', 'wait_ms_clamped', 'todos', 'active',
  'completed', 'cancelled', 'event_emitted', 'created', 'bytes_written',
  'encoding', 'bom', 'version', 'summary', 'cadence', 'tasks', 'queuedTotal',
  'undeliveredTotal', 'terminalTotal', 'linesTruncated', 'fullOutputPath',
  'desktop_output_truncation', 'desktop_output_continuation', 'truncation',
  'mcp', 'server', 'tool', 'ok', 'url', 'final_url', 'http_status',
  'content_type', 'bytes', 'token_truncated', 'original_estimated_tokens',
  'returned_estimated_tokens', 'max_result_tokens', 'retrieval_outcome',
  'retry_after', 'status_code', 'kind', 'skill', 'found', 'readable', 'owner',
  'source', 'location', 'proposal', 'goal', 'goalSnapshotPhase',
  'terminates_turn', 'request_id', 'schema_version', 'step_count',
  'waiting_for_user', 'agent_name', 'sub_session_id', 'sub_turn_id',
]);

// bound the work a single list row costs: name derivation reads only the first
// line and never more than this many bytes of it
const NAME_MAX_BYTES = 96 * 1024;

// ------------------------------------------------------------------ low level

// Read at most `maxBytes`, cut at the first newline. `truncated` means the line
// is longer than maxBytes, so the caller must not treat it as a record.
export async function readFirstLine(filePath, maxBytes = NAME_MAX_BYTES) {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await fh.read(buf, 0, maxBytes + 1, 0);
    const data = buf.subarray(0, bytesRead);
    const nl = data.indexOf(0x0a);
    if (nl < 0) return { line: data.length ? data.toString('utf8') : '', truncated: true };
    return { line: data.subarray(0, nl).toString('utf8'), truncated: false };
  } catch (e) {
    return { line: '', truncated: false, error: e };
  } finally {
    try { await fh?.close(); } catch { /* noop */ }
  }
}

// Iterate lines without loading the whole file. A final line not terminated by
// a newline (file is mid-write) is yielded ok:false so callers can WARN about
// it instead of silently discarding it.
export async function* iterateLines(filePath, { signal } = {}) {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(1 << 18); // 256 KiB
    let carry = '';
    let offset = 0;
    for (;;) {
      if (signal?.aborted) return;
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      carry += buf.subarray(0, bytesRead).toString('utf8');
      let nl;
      while ((nl = carry.indexOf('\n')) >= 0) {
        yield { text: carry.slice(0, nl), ok: true };
        carry = carry.slice(nl + 1);
      }
      if (bytesRead < buf.length) break; // EOF: remainder handled below
    }
    if (carry.length) yield { text: carry, ok: false };
  } finally {
    try { await fh?.close(); } catch { /* noop */ }
  }
}

// -------------------------------------------------------------------- parsing

// Parse a session's messages.jsonl, streaming. The file is never held whole;
// `records` holds one descriptor per record (raw text + parsed object), which
// is what makes raw + detailed exports lossless and chronology exact.
export async function parseSession(filePath, { signal } = {}) {
  const records = [];
  const stats = {
    records: 0, valid: 0, malformed: 0,
    incompleteTrailing: false,
    roles: {}, blockTypes: {}, tools: {},
    toolCalls: 0, toolResults: 0,
    unknownRoles: {}, unknownBlockTypes: {}, unknownTopKeys: {}, unknownMessageKeys: {},
    unknownDetailKeys: {},
    firstUserText: null, firstUserMessageId: null,
    models: {}, providers: {}, cwds: {}, turnCount: 0,
  };
  const calls = new Map();   // toolCall id -> [recordIndex]
  const results = new Map(); // toolCallId -> [recordIndex]
  const turns = new Set();
  let recordIndex = 0;
  let lastLineTerminated = true;

  for await (const { text, ok } of iterateLines(filePath, { signal })) {
    if (!text.length) continue; // blank lines are not records
    recordIndex++;
    lastLineTerminated = ok;
    const rec = { index: recordIndex, raw: text, obj: null, error: null };
    try { rec.obj = JSON.parse(text); stats.valid++; }
    catch (e) { rec.error = e.message; stats.malformed++; }
    records.push(rec);
    stats.records = recordIndex;

    const parsed = rec.obj;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const k of Object.keys(parsed)) {
        if (!KNOWN_TOP_KEYS.has(k)) stats.unknownTopKeys[k] = (stats.unknownTopKeys[k] || 0) + 1;
      }
      if (parsed.turn_id) turns.add(parsed.turn_id);
    }
    const msg = parsed && parsed.message;
    const role = msg && typeof msg === 'object' && !Array.isArray(msg) ? msg.role : null;
    stats.roles[role ?? '(none)'] = (stats.roles[role ?? '(none)'] || 0) + 1;
    if (role && !KNOWN_ROLES.has(role)) stats.unknownRoles[role] = (stats.unknownRoles[role] || 0) + 1;
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      for (const k of Object.keys(msg)) {
        if (!KNOWN_MESSAGE_KEYS.has(k)) stats.unknownMessageKeys[k] = (stats.unknownMessageKeys[k] || 0) + 1;
      }
      if (msg.model) stats.models[msg.model] = (stats.models[msg.model] || 0) + 1;
      if (msg.provider) stats.providers[msg.provider] = (stats.providers[msg.provider] || 0) + 1;
      const d = msg.details;
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        for (const k of Object.keys(d)) if (!KNOWN_DETAIL_KEYS.has(k)) stats.unknownDetailKeys[k] = (stats.unknownDetailKeys[k] || 0) + 1;
      }
    }

    const content = msg && Array.isArray(msg.content) ? msg.content : null;
    if (content) {
      for (const b of content) {
        const t = b && typeof b === 'object' ? b.type : '(none)';
        stats.blockTypes[t] = (stats.blockTypes[t] || 0) + 1;
        if (t && !KNOWN_BLOCK_TYPES.has(t)) stats.unknownBlockTypes[t] = (stats.unknownBlockTypes[t] || 0) + 1;
        if (t === 'toolCall') {
          stats.toolCalls++;
          stats.tools[b.name || '(unnamed)'] = (stats.tools[b.name || '(unnamed)'] || 0) + 1;
          if (b.id != null) {
            const list = calls.get(b.id) ?? [];
            list.push(recordIndex);
            calls.set(b.id, list);
          }
        }
      }
    }
    if (role === 'toolResult') {
      stats.toolResults++;
      if (msg.toolCallId != null) {
        const list = results.get(msg.toolCallId) ?? [];
        list.push(recordIndex);
        results.set(msg.toolCallId, list);
      }
    }
    if (role === 'user' && stats.firstUserText == null) {
      const t = firstUserText(msg);
      if (t) { stats.firstUserText = t; stats.firstUserMessageId = parsed?.message_id ?? null; }
    }
  }
  stats.turnCount = turns.size;
  if (!lastLineTerminated && recordIndex > 0) stats.incompleteTrailing = true;

  // ---- pair toolCall.id with toolResult.message.toolCallId ----------------
  const used = new Set();
  const pairs = [];
  const missing = [];
  const orphan = [];
  const duplicateCalls = [];
  const duplicateResults = [];
  for (const [id, idxs] of calls) {
    if (idxs.length > 1) duplicateCalls.push({ id, records: idxs });
    const res = results.get(id);
    if (res?.length) {
      used.add(id);
      if (res.length > 1) duplicateResults.push({ id, records: res });
      pairs.push({ toolCallId: id, callRecords: idxs, resultRecords: res });
    } else missing.push({ id, records: idxs });
  }
  for (const [id, idxs] of results) if (!used.has(id)) orphan.push({ id, records: idxs });

  return {
    file: filePath,
    records,
    stats,
    events: records.map(r => eventOf(r)),
    pairing: {
      matched: pairs.length,
      pairs,
      missingResults: missing,
      orphanResults: orphan,
      duplicateCallIds: duplicateCalls,
      duplicateResultIds: duplicateResults,
    },
  };
}

// One render-ready event descriptor per record. The record itself keeps all
// data; this only describes WHERE things are (used by the TUI + markdown).
export function eventOf(rec) {
  const obj = rec.obj;
  const msg = obj && obj.message;
  const role = msg?.role ?? null;
  const content = msg && Array.isArray(msg.content) ? msg.content : null;
  const ev = {
    index: rec.index,
    role,
    messageId: obj?.message_id ?? null,
    turnId: obj?.turn_id ?? null,
    error: rec.error ?? null,
  };
  if (content) {
    ev.blocks = content.map(b => ({
      kind: b?.type ?? '(none)',
      toolCallId: b?.id ?? null,
      toolName: b?.name ?? null,
      hasArguments: b && b.arguments != null,
    }));
    ev.text = content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
  } else if (typeof msg?.content === 'string') {
    ev.text = msg.content;
  }
  if (role === 'toolResult') {
    ev.toolCallId = msg.toolCallId ?? null;
    ev.toolName = msg.toolName ?? null;
    ev.isError = msg.isError === true || msg.details?.is_error === true;
    ev.status = msg.details?.execution?.status ?? msg.details?.status ?? null;
    ev.exitCode = msg.details?.execution?.exitCode ?? msg.details?.processOutput?.exitCode ?? null;
  }
  if (msg?.model) ev.model = msg.model;
  if (msg?.provider) ev.provider = msg.provider;
  return ev;
}

// The first user message usually carries injected <system-reminder> context
// (agent-context, tool reminders). Strip those so a DERIVED name is the
// human's actual request, not runtime scaffolding.
export function firstUserText(msg) {
  if (!msg) return null;
  let t = null;
  if (Array.isArray(msg.content)) t = msg.content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
  else if (typeof msg.content === 'string') t = msg.content;
  else if (typeof msg.genuineUserQueryText === 'string') t = msg.genuineUserQueryText;
  if (!t) return null;
  const stripped = String(t)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<agent-context>[\s\S]*?<\/agent-context>/g, '')
    .replace(/<mcode-tools-master-reminder>[\s\S]*?<\/mcode-tools-master-reminder>/g, '')
    .replace(/<task-completion-reminder>[\s\S]*?<\/task-completion-reminder>/g, '')
    .trim();
  return stripped || null;
}

// ---------------------------------------------------------------- integrity

// Full integrity report for one parsed session. Counts are derived, never
// hard-coded, so a future schema change shows up as a new "unknown" entry
// rather than a wrong total.
export function integrityReport(parsed, { name = null, nameSource = null } = {}) {
  const s = parsed.stats;
  const p = parsed.pairing;
  return {
    sessionName: name,
    nameSource,
    file: parsed.file,
    records: s.records,
    validRecords: s.valid,
    malformedRecords: s.malformed,
    incompleteTrailingRecord: s.incompleteTrailing,
    roles: { ...s.roles },
    contentBlockTypes: { ...s.blockTypes },
    toolCalls: s.toolCalls,
    toolResults: s.toolResults,
    matchedCallsResults: p.matched,
    missingResults: p.missingResults.length,
    orphanResults: p.orphanResults.length,
    duplicateCallIds: p.duplicateCallIds.length,
    duplicateResultIds: p.duplicateResultIds.length,
    unknownRoles: Object.keys(s.unknownRoles),
    unknownBlockTypes: Object.keys(s.unknownBlockTypes),
    unknownTopLevelFields: Object.keys(s.unknownTopKeys),
    unknownMessageFields: Object.keys(s.unknownMessageKeys),
    unknownToolFields: Object.keys(s.unknownDetailKeys),
    detailKeysSeen: Object.keys(s.unknownDetailKeys).length === 0
      ? detailKeysFromRecords(parsed)
      : Object.keys(s.unknownDetailKeys),
    ok: s.malformed === 0 && !s.incompleteTrailing
      && p.missingResults.length === 0 && p.orphanResults.length === 0,
  };
}
function detailKeysFromRecords(parsed) {
  const set = new Set();
  for (const r of parsed.records) {
    const d = r.obj?.message?.details;
    if (d && typeof d === 'object' && !Array.isArray(d)) for (const k of Object.keys(d)) set.add(k);
  }
  return [...set].sort();
}

// ------------------------------------------------------------------ naming

// Derive a human name, in preference order. NEVER writes anything anywhere.
//   stored       -> the runtime's own title column (SQLite)
//   summary      -> a compactionSummary's own heading
//   first-user   -> first GENUINE user message
//   fallback     -> <cwd basename> + <date> from the dated directory
export function deriveName(opts = {}) {
  const { storedTitle = null, firstUserText = null, summary = null, cwd = null, dirName = null, createdAtMs = null } = opts;
  if (storedTitle && String(storedTitle).trim()) {
    return { name: clip(String(storedTitle).trim(), 120), source: 'stored title' };
  }
  if (summary) {
    const head = String(summary).split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean);
    if (head) return { name: clip(head, 120), source: 'stored compaction summary' };
  }
  if (firstUserText) {
    const first = String(firstUserText).split('\n').map(l => l.trim()).find(Boolean);
    if (first) return { name: clip(first, 120), source: 'first user message' };
  }
  const base = cwd ? String(cwd).split('/').filter(Boolean).pop() : '';
  const stamp = dirStamp(dirName) || isoDay(createdAtMs) || '';
  const name = [base || 'session', stamp].filter(Boolean).join(' ');
  return { name: name || 'untitled session', source: 'derived (cwd + timestamp)' };
}
function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
// 2026/09/25/23-11-16-964-session_... -> 2026-09-25 23:11
function dirStamp(dirName) {
  const m = /(\d{4})[/-](\d{2})[/-](\d{2})[/-](\d{2})-(\d{2})/.exec(String(dirName ?? ''));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}
function isoDay(ms) {
  if (!Number.isFinite(Number(ms))) return null;
  try { return new Date(Number(ms)).toISOString().slice(0, 10); } catch { return null; }
}

// ------------------------------------------------------------------ hashing
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
export async function sha256File(filePath) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) h.update(chunk);
  return h.digest('hex');
}

// ------------------------------------------------------------------ record access
// find the record that carries a given toolCall id, and the result(s) for it
export function recordsForToolCallId(parsed, id) {
  const callRecords = [];
  const resultRecords = [];
  for (const r of parsed.records) {
    const msg = r.obj?.message;
    if (Array.isArray(msg?.content)) {
      for (const b of msg.content) {
        if (b?.type === 'toolCall' && b.id === id) callRecords.push(r);
      }
    }
    if (msg?.role === 'toolResult' && msg.toolCallId === id) resultRecords.push(r);
  }
  return { callRecords, resultRecords };
}
