// High-fidelity session exports for mcode 0.5.5 file-store sessions.
//
// Every artifact is written INSIDE this tool's own checkout (EXPORT_DIR, which
// defaults to <checkout>/exports). Nothing is ever written into ~/.minimax, and
// the source session is never opened for writing or locked in any way.
//
// Formats
//   raw       raw_messages.jsonl          byte-for-byte copy of the source
//   json      detailed.json               every record, verbatim
//   markdown  detailed.md                 human-readable chronological dump
//   archive   <name>.tar.gz               the whole ORIGINAL session directory
//   bundle    <name>/                     raw + detailed + info + integrity
//   info      session_info.json           derived metadata (stored vs derived)
//   integrity integrity.txt               validation report
//
// LOSSLESSNESS: raw is a byte copy, verified against the source's sha256.
// detailed.* keep each record's parsed object intact, so any field this tool
// does not understand — including fields future mcode releases add — survives.
// `--redact` produces a clearly-labelled, deliberately-lossy variant for
// sharing; it never touches the source and never claims to be complete.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EXPORT_DIR, mcodeVersion } from './env.js';
import {
  parseSession, integrityReport, sha256Hex, sha256File,
} from './jsonl.js';

export const EXPORT_FORMATS = ['raw', 'json', 'markdown', 'archive', 'bundle', 'info', 'integrity'];

const EXPORTER_VERSION = 'msm-store-1.0';

// ------------------------------------------------------------------ redaction

// Best-effort redaction of obvious credentials. Deliberately conservative: it
// rewrites VALUE-looking text, reports how many substitutions it made, and
// never claims completeness. The raw session is untouched.
const SECRET_PATTERNS = [
  [/(sk-[A-Za-z0-9_\-]{12,})/g, 'sk-***REDACTED***'],
  [/((?:Bearer|bearer)\s+)([A-Za-z0-9_\-\.=]{12,})/g, (m, p1) => `${p1}***REDACTED***`],
  [/((?:authorization|x-api-key|api[_-]?key|apikey|token|secret|password|passwd|pwd|client[_-]?secret)["'\s:=]+)([^\s"']{6,})/gi, (m, p1) => `${p1}***REDACTED***`],
  [/([A-Za-z0-9_\-]*(?:api[_-]?key|secret|token|password|credential)[A-Za-z0-9_\-]*["'\s:=]+)([^\s"']{6,})/gi, (m, p1) => `${p1}***REDACTED***`],
  [/(-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/g, '***REDACTED-PRIVATE-KEY***'],
];
// whole JSONL records whose tool/result text looks key-bearing are also masked
const KEYISH = /(?:api[_-]?key|secret|token|password|bearer|authorization|credential)/i;

export function redactText(text) {
  let out = String(text ?? '');
  let hits = 0;
  for (const [re, rep] of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => { hits++; return typeof rep === 'function' ? rep(...args) : rep; });
  }
  return { text: out, hits };
}
// Redact a parsed object by re-serialising and masking secret-looking values,
// then parsing back. Keeps every key and the overall structure.
export function redactParsed(obj) {
  const s = JSON.stringify(obj);
  const { text, hits } = redactText(s);
  if (!hits) return { obj, hits: 0 };
  try { return { obj: JSON.parse(text), hits }; } catch { return { obj, hits }; }
}

// ------------------------------------------------------------------ helpers

function ensureDir(d) { mkdirSync(d, { recursive: true }); return d; }
function safeName(s) {
  return String(s ?? 'session').replace(/[^\w\-.]+/g, '_').slice(0, 80) || 'session';
}
function bytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

// A snapshot of the source file taken BEFORE the export, so a session that
// mcode is actively writing can be detected and reported afterwards.
async function snapshotFile(filePath) {
  try {
    const st = statSync(filePath);
    return { size: st.size, mtimeMs: st.mtimeMs, sha: await sha256File(filePath) };
  } catch (e) { return { size: null, mtimeMs: null, sha: null, error: e.message }; }
}
async function changedSince(before, filePath) {
  try {
    const st = statSync(filePath);
    if (before.size !== st.size || before.mtimeMs !== st.mtimeMs) return { changed: true, size: st.size };
    const sha = await sha256File(filePath);
    return { changed: sha !== before.sha, size: st.size, sha };
  } catch (e) { return { changed: true, error: e.message }; }
}

// ------------------------------------------------------------------ main entry

export async function exportSession(entry, {
  format = 'bundle',
  out = null,       // file (raw/json/md/info/integrity) or directory (bundle)
  redact = false,
  maxRecords = null, // optional cap for markdown (null = everything)
  log = null,
} = {}) {
  if (!entry) throw new Error('no session entry');
  if (!EXPORT_FORMATS.includes(format)) {
    throw new Error(`unknown export format: ${format} (use ${EXPORT_FORMATS.join(' | ')})`);
  }
  const mp = entry.messagesPath;
  if (!mp || !existsSync(mp)) {
    throw new Error(`session has no messages.jsonl to export: ${entry.dir}`);
  }
  const before = await snapshotFile(mp);
  const parsed = await parseSession(mp);
  const nameInfo = await entry.nameInfo();
  const info = sessionInfo(entry, parsed, { nameInfo, source: before });
  const integ = integrityReport(parsed, { name: nameInfo.name, nameSource: nameInfo.source });
  const base = safeName(nameInfo.name);

  const result = { format, redacted: !!redact, session: entry.sessionId, name: nameInfo.name, warnings: [] };

  if (format === 'info') {
    const target = resolveOut(out, EXPORT_DIR, base, 'session_info.json');
    writeText(target, redact ? redactParsed(info).obj : info);
    result.files = [target];
  } else if (format === 'integrity') {
    const target = resolveOut(out, EXPORT_DIR, base, 'integrity.txt');
    writeText(target, renderIntegrity(integ, redact ? redactParsed(info).obj : info, parsed));
    result.files = [target];
  } else if (format === 'raw') {
    const target = resolveOut(out, EXPORT_DIR, base, redact ? 'raw_messages.redacted.jsonl' : 'raw_messages.jsonl');
    await copyRaw(mp, target, { redact, result });
    result.files = [target];
  } else if (format === 'json') {
    const target = resolveOut(out, EXPORT_DIR, base, redact ? 'detailed.redacted.json' : 'detailed.json');
    const body = buildDetailedJson(entry, parsed, info, integ, { redact });
    writeText(target, body);
    result.files = [target];
  } else if (format === 'markdown') {
    const target = resolveOut(out, EXPORT_DIR, base, redact ? 'detailed.redacted.md' : 'detailed.md');
    writeText(target, buildMarkdown(entry, parsed, info, integ, { redact, maxRecords }));
    result.files = [target];
  } else if (format === 'archive') {
    const target = resolveOut(out, EXPORT_DIR, base, 'tar.gz', true);
    await archiveSessionDir(entry.dir, target);
    result.files = [target];
  } else if (format === 'bundle') {
    const dir = resolveOutDir(out, EXPORT_DIR, base);
    result.files = await writeBundle(dir, entry, parsed, info, integ, { redact, before });
  }

  // live-session detection: did the source move while we were exporting?
  const after = await changedSince(before, mp);
  if (after.changed) {
    const w = `WARNING: session changed during export (size ${before.size} -> ${after.size ?? '?'}); the export is a snapshot of a live session`;
    result.warnings.push(w);
    if (after.error) result.warnings.push(`could not re-check source: ${after.error}`);
  }
  if (parsed.stats.incompleteTrailing) {
    result.warnings.push('WARNING: SESSION MAY CURRENTLY BE IN USE — trailing record is incomplete (exported as-is)');
  }
  if (parsed.stats.malformed) {
    result.warnings.push(`WARNING: ${parsed.stats.malformed} malformed record(s) exported verbatim as raw text`);
  }
  if (redact) result.warnings.push('NOTE: redaction is best-effort and NOT guaranteed complete; review before sharing');
  result.integrity = { ok: integ.ok, toolCalls: integ.toolCalls, toolResults: integ.toolResults, matched: integ.matchedCallsResults, missing: integ.missingResults, orphan: integ.orphanResults };
  log?.verbose(`export ${format} -> ${result.files.join(', ')}`);
  return result;
}

function resolveOut(out, dflt, base, filename, asSiblingOfBase = false) {
  if (out) return path.resolve(out);
  ensureDir(path.join(dflt, base));
  // an archive of the whole directory sits beside the export dir, not in it
  if (asSiblingOfBase) return path.join(dflt, `${base}.${filename}`);
  return path.join(dflt, base, filename);
}
function resolveOutDir(out, dflt, base) {
  const dir = out ? path.resolve(out) : path.join(dflt, base);
  return ensureDir(dir);
}
function writeText(target, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n';
  writeFileSync(target, text);
  return target;
}

// raw copy: byte-for-byte. With --redact we cannot be byte-identical, so the
// file is clearly named .redacted. and the lossless guarantee does not apply.
async function copyRaw(src, target, { redact, result }) {
  if (!redact) {
    // stream copy, then verify with sha256 against the source
    await pipeline(createReadStream(src), createWriteStream(target));
    const [a, b] = await Promise.all([sha256File(src), sha256File(target)]);
    result.rawSha256 = { source: a, export: b, byteIdentical: a === b };
    if (a !== b) result.warnings.push('WARNING: raw export is NOT byte-identical to the source');
    return;
  }
  let hits = 0;
  const w = createWriteStream(target);
  for await (const { text } of linesOf(src)) {
    const { text: t, hits: h } = redactText(text);
    hits += h;
    w.write(t + '\n');
  }
  await new Promise((res, rej) => { w.end(err => err ? rej(err) : res()); });
  result.redactionHits = (result.redactionHits ?? 0) + hits;
}
async function* linesOf(filePath) {
  let buf = '';
  for await (const chunk of createReadStream(filePath)) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { yield { text: buf.slice(0, nl) }; buf = buf.slice(nl + 1); }
  }
  if (buf.length) yield { text: buf };
}

// ------------------------------------------------------------- detailed json

// Every record exactly as parsed, plus pairing and derived metadata. Unknown
// fields are carried through inside each record's own `message` object.
function buildDetailedJson(entry, parsed, info, integ, { redact }) {
  const records = parsed.records.map(r => {
    const o = { index: r.index, message_id: r.obj?.message_id ?? null, turn_id: r.obj?.turn_id ?? null };
    if (r.error) o.parseError = r.error;
    o.message = redact ? redactParsed(r.obj?.message ?? null).obj : (r.obj?.message ?? null);
    if (r.obj?.history_artifact) o.history_artifact = redact ? redactParsed(r.obj.history_artifact).obj : r.obj.history_artifact;
    if (r.raw) o.raw = redact ? redactText(r.raw).text : r.raw;
    // verbatim source line; nothing is reconstructed. Under --redact the raw
    // line is masked too, or it would carry every secret we just removed.
    return o;
  });
  const body = {
    export: {
      exporterVersion: EXPORTER_VERSION,
      format: 'detailed-json',
      redacted: !!redact,
      exportedAt: new Date().toISOString(),
      chronology: 'original stored order; not re-sorted or merged',
    },
    sessionInfo: redact ? redactParsed(info).obj : info,
    integrity: integ,
    pairing: parsed.pairing,
    records,
  };
  return body;
}

// ---------------------------------------------------------------- markdown

// Readable chronological dump. Every record is rendered, in the ORIGINAL stored
// order, with tool calls and results shown in full (arguments, stdout, stderr,
// details). Nothing is merged away.
export function buildMarkdown(entry, parsed, info, integ, { redact = false, maxRecords = null } = {}) {
  const L = [];
  const nm = info.name ?? '(untitled)';
  L.push('# mcode session', '');
  L.push(`name: ${nm}`);
  L.push(`name source: ${info.nameSource}`);
  L.push(`session id: ${info.sessionId}`);
  L.push(`source: ${info.sourcePath}`);
  L.push(`mcode version: ${info.detectedMcodeVersion ?? 'unknown'}`);
  L.push(`layout: ${info.layout ?? 'unknown'}`);
  L.push(`created: ${info.createdIso ?? '?'}`);
  L.push(`modified: ${info.modifiedIso ?? '?'}`);
  L.push(`file size: ${bytes(info.sourceSize)}`);
  L.push(`records: ${info.recordCount}`);
  L.push(`user messages: ${info.counts.roles.user ?? 0}`);
  L.push(`assistant messages: ${info.counts.roles.assistant ?? 0}`);
  L.push(`thinking blocks: ${info.counts.blockTypes.thinking ?? 0}`);
  L.push(`tool calls: ${integ.toolCalls}`);
  L.push(`tool results: ${integ.toolResults}`);
  L.push(`matched: ${integ.matchedCallsResults}`);
  L.push(`missing results: ${integ.missingResults}`);
  L.push(`orphan results: ${integ.orphanResults}`);
  if (info.model) L.push(`model: ${info.model}`);
  if (info.provider) L.push(`provider: ${info.provider}`);
  if (info.workspace) L.push(`cwd: ${info.workspace}`);
  if (info.parentId) L.push(`parent session: ${info.parentId}`);
  if (info.isBranch) L.push(`branch/subagent: yes`);
  if (info.status) L.push(`status: ${info.status}`);
  L.push('');
  L.push('---', '');

  const n = maxRecords && maxRecords > 0 ? Math.min(maxRecords, parsed.records.length) : parsed.records.length;
  for (let i = 0; i < n; i++) {
    const r = parsed.records[i];
    const ev = parsed.events[i];
    L.push(`## record ${r.index} — ${ev.role ?? 'unknown'}`, '');
    if (r.error) {
      L.push('**malformed record** (kept verbatim):', '', '```', r.raw, '```', '');
      L.push('---', '');
      continue;
    }
    if (r.obj?.message_id) L.push(`message_id: \`${r.obj.message_id}\``, '');
    if (r.obj?.turn_id) L.push(`turn_id: \`${r.obj.turn_id}\``, '');

    const msg = r.obj?.message;
    const content = Array.isArray(msg?.content) ? msg.content : null;
    if (content) {
      for (const b of content) {
        const t = b?.type;
        if (t === 'text') {
          L.push('### text', '');
          L.push(redact ? redactText(b.text).text : String(b.text ?? ''));
          L.push('');
        } else if (t === 'thinking') {
          L.push('### thinking', '');
          L.push(redact ? redactText(b.thinking).text : String(b.thinking ?? ''));
          if (b.thinkingSignature) L.push('', `_(thinkingSignature: ${b.thinkingSignature})_`);
          L.push('');
        } else if (t === 'toolCall') {
          L.push('### tool call', '');
          L.push(`id: \`${b.id ?? '(none)'}\``, '');
          L.push(`name: \`${b.name ?? '(unnamed)'}\``, '');
          L.push('arguments:', '', '```json');
          L.push(redact ? redactText(JSON.stringify(b.arguments ?? {}, null, 2)).text : JSON.stringify(b.arguments ?? {}, null, 2));
          L.push('```', '');
        } else {
          L.push(`### ${String(t)}`, '');
          L.push('```json');
          L.push(redact ? redactText(JSON.stringify(b, null, 2)).text : JSON.stringify(b, null, 2));
          L.push('```', '');
        }
      }
    } else if (typeof msg?.content === 'string') {
      L.push('### text', '');
      L.push(redact ? redactText(msg.content).text : msg.content);
      L.push('');
    }

    if (ev.role === 'toolResult') {
      L.push('### tool result', '');
      L.push(`tool call id: ${msg.toolCallId ?? '(none)'}`, '');
      L.push(`tool name: ${msg.toolName ?? '(none)'}`, '');
      const exec = msg.details?.execution;
      L.push(`status: ${exec?.status ?? msg.details?.status ?? '(unknown)'}`);
      if (exec?.exitCode != null) L.push(`exitCode: ${exec.exitCode}`);
      if (exec?.message) L.push(`message: ${exec.message}`);
      if (msg.isError) L.push('isError: true');
      const po = msg.details?.processOutput;
      if (po) {
        L.push('', 'stdout:', '', '```');
        L.push(redact ? redactText(po.stdout ?? '').text : String(po.stdout ?? ''));
        L.push('```', '', 'stderr:', '', '```');
        L.push(redact ? redactText(po.stderr ?? '').text : String(po.stderr ?? ''));
        L.push('```', '',
          `stdoutTruncated: ${po.stdoutTruncated}   stderrTruncated: ${po.stderrTruncated}   interrupted: ${po.interrupted}`);
      }
      if (msg.content && !po) {
        L.push('', 'content:', '', '```');
        L.push(redact ? redactText(stringifyContent(msg.content)).text : stringifyContent(msg.content));
        L.push('```');
      }
      if (msg.details) {
        L.push('', 'details:', '', '```json');
        L.push(redact ? redactText(JSON.stringify(msg.details, null, 2)).text : JSON.stringify(msg.details, null, 2));
        L.push('```');
      }
      L.push('');
    }

    // any other message-level field we do not specifically render is shown
    // explicitly rather than dropped
    const extras = otherMessageKeys(msg);
    if (extras.length) {
      L.push('### additional metadata', '', '```json');
      const pick = {};
      for (const k of extras) pick[k] = msg[k];
      L.push(redact ? redactText(JSON.stringify(pick, null, 2)).text : JSON.stringify(pick, null, 2));
      L.push('```', '');
    }
    if (r.obj?.history_artifact) {
      L.push('### history_artifact', '', '```json');
      L.push(JSON.stringify(r.obj.history_artifact, null, 2));
      L.push('```', '');
    }
    L.push('---', '');
  }
  if (n < parsed.records.length) L.push(`… ${parsed.records.length - n} more record(s) (raise --max-records)`, '');
  return L.join('\n');
}

function stringifyContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => b?.text ?? JSON.stringify(b)).join('\n');
  return JSON.stringify(content, null, 2);
}
const RENDERED_MSG_KEYS = new Set([
  'role', 'content', 'timestamp', 'toolCallId', 'toolName', 'details', 'isError', 'model', 'provider',
]);
function otherMessageKeys(msg) {
  if (!msg || typeof msg !== 'object') return [];
  return Object.keys(msg).filter(k => !RENDERED_MSG_KEYS.has(k));
}

// ------------------------------------------------------------------ bundle

async function writeBundle(dir, entry, parsed, info, integ, { redact, before }) {
  const files = [];
  // raw (lossless unless redacted)
  const rawName = redact ? 'raw_messages.redacted.jsonl' : 'raw_messages.jsonl';
  const rawPath = path.join(dir, rawName);
  await copyRaw(entry.messagesPath, rawPath, { redact, result: {} });
  files.push(rawPath);
  // detailed json + markdown
  writeText(path.join(dir, redact ? 'detailed.redacted.json' : 'detailed.json'), buildDetailedJson(entry, parsed, info, integ, { redact }));
  files.push(path.join(dir, redact ? 'detailed.redacted.json' : 'detailed.json'));
  writeText(path.join(dir, redact ? 'detailed.redacted.md' : 'detailed.md'), buildMarkdown(entry, parsed, info, integ, { redact }));
  files.push(path.join(dir, redact ? 'detailed.redacted.md' : 'detailed.md'));
  // session info (stored vs derived) + integrity report
  writeText(path.join(dir, 'session_info.json'), redact ? redactParsed(info).obj : info);
  files.push(path.join(dir, 'session_info.json'));
  writeText(path.join(dir, 'integrity.txt'), renderIntegrity(integ, redact ? redactParsed(info).obj : info, parsed));
  files.push(path.join(dir, 'integrity.txt'));
  // original metadata sidecars (manifest, catalog, locators, llm-call) — the
  // messages themselves are already in raw_messages.jsonl
  for (const name of entry.sidecars) {
    if (name === 'snapshots' || name === 'reports') continue; // large; archive format keeps them
    const src = path.join(entry.dir, name);
    try {
      const st = statSync(src);
      if (st.isDirectory()) continue;
      copyFileSync(src, path.join(dir, name));
      files.push(path.join(dir, name));
    } catch { /* skip unreadable sidecars */ }
  }
  // manifest of checksums so a bundle is self-verifying
  const manifest = await checksumManifest(files, { source: entry.messagesPath, sourceSha: before.sha, redacted: !!redact });
  writeText(path.join(dir, 'MANIFEST.sha256'), manifest);
  files.push(path.join(dir, 'MANIFEST.sha256'));
  return files;
}

async function checksumManifest(files, { source, sourceSha, redacted }) {
  const L = ['# msm export manifest', `# generated: ${new Date().toISOString()}`, `# redacted: ${redacted}`, ''];
  if (source) L.push(`# source: ${source}`, `source-sha256: ${sourceSha ?? '?'}`, '');
  for (const f of files) {
    if (f.endsWith('MANIFEST.sha256')) continue;
    const sha = await sha256File(f);
    L.push(`${sha}  ${path.basename(f)}`);
  }
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- integrity txt

export function renderIntegrity(integ, info, parsed = null) {
  const L = ['mcode session integrity report', ''];
  L.push(`session: ${info?.name ?? integ.sessionName ?? '?'}`);
  L.push(`name source: ${info?.nameSource ?? integ.nameSource ?? '?'}`);
  L.push(`session id: ${info?.sessionId ?? '?'}`);
  L.push(`source: ${integ.file}`, '');
  L.push('--- records ---');
  L.push(`total records: ${integ.records}`);
  L.push(`valid records: ${integ.validRecords}`);
  L.push(`malformed records: ${integ.malformedRecords}`);
  L.push(`incomplete trailing record: ${integ.incompleteTrailingRecord ? 'YES (session may be in use)' : 'no'}`);
  L.push(`turns: ${info?.counts?.turns ?? '?'}`, '');
  L.push('--- roles ---');
  for (const [r, n] of Object.entries(integ.roles).sort()) L.push(`${r}: ${n}`);
  L.push('', '--- content block types ---');
  for (const [t, n] of Object.entries(integ.contentBlockTypes).sort()) L.push(`${t}: ${n}`);
  L.push('', '--- tools ---');
  const tools = info?.counts?.tools ?? {};
  for (const [t, n] of Object.entries(tools).sort((a, b) => b[1] - a[1])) L.push(`${t}: ${n}`);
  L.push('', '--- tool call / result pairing ---');
  L.push(`tool calls: ${integ.toolCalls}`);
  L.push(`tool results: ${integ.toolResults}`);
  L.push(`matched: ${integ.matchedCallsResults}`);
  L.push(`missing results: ${integ.missingResults}`);
  L.push(`orphan results: ${integ.orphanResults}`);
  L.push(`duplicate call ids: ${integ.duplicateCallIds}`);
  L.push(`duplicate result ids: ${integ.duplicateResultIds}`);
  if (integ.missingResults && parsed?.pairing) {
    L.push('', 'missing-result call ids:');
    for (const m of parsed.pairing.missingResults.slice(0, 50)) L.push(`  ${m.id}  (record ${m.records.join(', ')})`);
  }
  if (integ.orphanResults && parsed?.pairing) {
    L.push('', 'orphan-result ids (result with no matching call):');
    for (const o of parsed.pairing.orphanResults.slice(0, 50)) L.push(`  ${o.id}  (record ${o.records.join(', ')})`);
  }
  L.push('', '--- unknown / future schema ---');
  L.push(`unknown roles: ${fmt(integ.unknownRoles)}`);
  L.push(`unknown content block types: ${fmt(integ.unknownBlockTypes)}`);
  L.push(`unknown top-level fields: ${fmt(integ.unknownTopLevelFields)}`);
  L.push(`unknown message fields: ${fmt(integ.unknownMessageFields)}`);
  L.push(`unknown tool fields: ${fmt(integ.unknownToolFields)}`);
  L.push('', `VERDICT: ${integ.ok ? 'OK — all calls matched, no malformed records' : 'ISSUES FOUND (see above)'}`);
  return L.join('\n') + '\n';
}
function fmt(a) { return a && a.length ? a.join(', ') : 'none'; }

// ------------------------------------------------------------------ session info

// Derived metadata, clearly split into STORED (read from the runtime's own
// records) and DERIVED (computed by this tool). Nothing here is written back.
export function sessionInfo(entry, parsed, { nameInfo, source } = {}) {
  const s = parsed.stats;
  const st = nameInfo ?? { name: '(untitled)', source: '?' };
  const stored = {};
  if (entry.storedTitle) stored.title = entry.storedTitle;
  if (entry.status) stored.status = entry.status;
  if (entry.archived) stored.archived = true;
  if (entry.sessionKind) stored.sessionKind = entry.sessionKind;
  if (entry.workspaceDir) stored.workspaceDir = entry.workspaceDir;
  if (entry.parentId) stored.parentSessionId = entry.parentId;
  if (entry.manifest) stored.manifest = entry.manifest;
  if (entry.catalog) stored.historyCatalog = entry.catalog;

  const models = Object.keys(s.models);
  const providers = Object.keys(s.providers);
  return {
    exporterVersion: EXPORTER_VERSION,
    detectedMcodeVersion: detectVersion(),
    detectedLayout: entry.mcodeLayout,
    sessionId: entry.sessionId,
    name: st.name,
    nameSource: st.source,
    sourcePath: entry.messagesPath,
    sourceSize: entry.messagesSize,
    sourceMtimeMs: entry.messagesMtimeMs,
    sourceSha256: source?.sha ?? null,
    recordCount: s.records,
    layout: entry.mcodeLayout,
    createdAtMs: entry.createdAtMs,
    updatedAtMs: entry.updatedAtMs,
    createdIso: iso(entry.createdAtMs),
    modifiedIso: iso(entry.updatedAtMs),
    counts: {
      roles: { ...s.roles },
      blockTypes: { ...s.blockTypes },
      tools: { ...s.tools },
      turns: s.turnCount,
      toolCalls: s.toolCalls,
      toolResults: s.toolResults,
      matched: parsed.pairing.matched,
      missingResults: parsed.pairing.missingResults.length,
      orphanResults: parsed.pairing.orphanResults.length,
    },
    model: models.length === 1 ? models[0] : (models.length ? models : null),
    provider: providers.length === 1 ? providers[0] : (providers.length ? providers : null),
    workspace: entry.workspaceDir ?? null,
    parentId: entry.parentId ?? null,
    isBranch: entry.isBranch,
    sidecars: entry.sidecars,
    integrity: {
      ok: s.malformed === 0 && !s.incompleteTrailing && parsed.pairing.missingResults.length === 0 && parsed.pairing.orphanResults.length === 0,
      malformedRecords: s.malformed,
      incompleteTrailingRecord: s.incompleteTrailing,
    },
    exportedAt: new Date().toISOString(),
    stored, // read from the runtime's own records
    derived: { // computed by this tool; never written back to the session
      name: st.name,
      nameSource: st.source,
      counts: true,
      model: models.length === 1 ? models[0] : (models.length ? models : null),
      provider: providers.length === 1 ? providers[0] : (providers.length ? providers : null),
      isBranch: entry.isBranch,
    },
  };
}
function iso(ms) {
  if (!Number.isFinite(Number(ms))) return null;
  try { return new Date(Number(ms)).toISOString(); } catch { return null; }
}
function detectVersion() {
  try { const v = mcodeVersion(); return v || 'unknown'; } catch { return 'unknown'; }
}

// ------------------------------------------------------------------ archive

// Preserve the complete ORIGINAL session directory (messages.jsonl and
// everything beside it) as a tar.gz. Source files are only ever READ.
export async function archiveSessionDir(sessionDir, target) {
  ensureDir(path.dirname(target));
  const args = ['-czf', target, '-C', path.dirname(sessionDir), path.basename(sessionDir)];
  await new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr?.on('data', d => { err += d; });
    child.on('error', e => reject(new Error(`tar failed: ${e.message}`)));
    child.on('exit', c => c === 0 ? resolve() : reject(new Error(`tar exited ${c}: ${err.trim()}`)));
  });
  return target;
}

export { EXPORTER_VERSION, EXPORT_DIR };
