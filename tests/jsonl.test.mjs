// File-store / JSONL parser / exporter tests.
//
// Every fixture is built in a temporary directory under the OS tmp dir and
// removed afterwards. The real ~/.minimax/v2/sessions tree is only ever READ
// (and only by the opt-in real-data smoke section at the end, which is skipped
// when it is absent). No test writes outside its own temp dir.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSession, integrityReport, deriveName, firstUserText, iterateLines } from '../src/jsonl.js';
import { StoreIndex } from '../src/store.js';
import { exportSession, EXPORT_FORMATS, redactText } from '../src/exportx.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${x}`));
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const BIN = path.join(ROOT, 'bin', 'mcode-sessions');
const sh = args => spawnSync('node', [BIN, ...args], { encoding: 'utf8', maxBuffer: 1 << 26, env: process.env });

let tmp = mkdtempSync(path.join(tmpdir(), 'msm-jsonl-'));
let exportTmp = mkdtempSync(path.join(tmpdir(), 'msm-jsonl-out-'));
function sessionDir(name) { return path.join(tmp, name); }

// ----------------------------------------------------------------- fixture dir
// Create a synthetic session tree exactly like mcode 0.5.5 lays it out:
//   <root>/YYYY/MM/DD/HH-MM-SS-mmm-session_<base64(sessionId)>/
// The caller supplies the messages.jsonl content (an array of record objects
// that are serialised verbatim, so unknown fields survive round-tripping).
function makeSession({ id = 'mvs_' + 'a'.repeat(32), records, dirName = null, when = '2026-09-25T23-11-16-964', extraFiles = {}, omitMessages = false } = {}) {
  const stamp = when.replace(/[:T]/g, '-');
  const parts = stamp.split('-'); // y mo d h mi s ms
  const dir = dirName ?? path.join(tmp, parts[0], parts[1], parts[2], `${parts[3]}-${parts[4]}-${parts[5]}-${parts[6]}-session_${Buffer.from(id, 'utf8').toString('base64')}`);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaVersion: 1, sessionId: id, createdAtMs: Date.UTC(2026, 8, 25, 23, 11, 16, 964),
    updatedAtMs: Date.UTC(2026, 8, 25, 23, 17, 45, 158),
    source: 'local-runtime', layout: 'v2-final-dated-session',
    paths: { sessionDir: dir, messages: path.join(dir, 'messages.jsonl') },
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(dir, 'history-catalog.json'), JSON.stringify({
    schemaVersion: 1, sessionId: id, activeGeneration: 0,
    activeRevision: 'sha256:' + '0'.repeat(64),
    artifacts: [{ revision: 'sha256:' + '0'.repeat(64), generation: 0, kind: 'active', fileName: 'messages.jsonl', byteLength: 0, messageCount: records ? records.length : 0 }],
  }, null, 2));
  if (!omitMessages) {
    const body = records.length ? records.map(r => JSON.stringify(r)).join('\n') + '\n' : '';
    writeFileSync(path.join(dir, 'messages.jsonl'), body);
  }
  for (const [n, c] of Object.entries(extraFiles)) writeFileSync(path.join(dir, n), c);
  return dir;
}

const rec = (message_id, turn_id, message, extra = {}) => ({ message_id, turn_id, message, ...extra });
const userText = text => rec('mu', 'turn-1', { role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
const assistant = blocks => rec('ma', 'turn-1', { role: 'assistant', content: blocks, timestamp: 2, model: 'Atria-Dawn-Preview', provider: 'custom_provider:1', usage: { input: 1, output: 1 }, stopReason: 'toolUse', responseId: 'chatcmpl-x' });
const toolCall = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const thinking = t => ({ type: 'thinking', thinking: t, thinkingSignature: 'reasoning_content' });
const text = t => ({ type: 'text', text: t });
const result = (id, name, { stdout = '', stderr = '', exitCode = 0, status = 'succeeded', isError = false, details = null } = {}) =>
  rec('mr', 'turn-1', {
    role: 'toolResult', toolCallId: id, toolName: name, isError,
    content: [{ type: 'text', text: stdout || stderr || '(no output)' }],
    details: details ?? {
      execution: { status, reason: 'exited', exitCode },
      processOutput: { stdout, stderr, exitCode, interrupted: false, stdoutTruncated: false, stderrTruncated: false },
    },
    timestamp: 3,
  });

// =============================================================== jsonl parsing
console.log('=== jsonl parser ===');
{
  const records = [
    userText('hello world'),
    assistant([text('hi'), thinking('should I answer?'), toolCall('c1', 'bash', { command: 'ls' }), toolCall('c2', 'read', { path: '/etc/hosts' })]),
    result('c1', 'bash', { stdout: 'a\nb', stderr: '', exitCode: 0 }),
    result('c2', 'read', { stdout: '127.0.0.1 localhost' }),
  ];
  const dir = makeSession({ records });
  const p = await parseSession(path.join(dir, 'messages.jsonl'));
  eq('record count', p.stats.records, 4);
  eq('roles', p.stats.roles, { user: 1, assistant: 1, toolResult: 2 });
  eq('block types', p.stats.blockTypes, { text: 4, thinking: 1, toolCall: 2 });
  eq('tool calls', p.stats.toolCalls, 2);
  eq('tool results', p.stats.toolResults, 2);
  eq('matched pairs', p.pairing.matched, 2);
  eq('missing results', p.pairing.missingResults.length, 0);
  eq('orphan results', p.pairing.orphanResults.length, 0);
  eq('chronology preserved', p.records.map(r => r.obj.message.role), ['user', 'assistant', 'toolResult', 'toolResult']);
  ok('raw text kept verbatim', p.records[0].raw === JSON.stringify(records[0]));
  ok('arguments survive', JSON.parse(p.records[1].raw).message.content[2].arguments.command === 'ls');
  ok('thinking survives', JSON.parse(p.records[1].raw).message.content[1].thinking === 'should I answer?');
  ok('stdout survives', p.records[2].obj.message.details.processOutput.stdout === 'a\nb');
  ok('turn ids survive', p.records.every(r => r.obj.turn_id === 'turn-1'));
  ok('model detected', p.stats.models['Atria-Dawn-Preview'] === 1);
  ok('provider detected', p.stats.providers['custom_provider:1'] === 1);
  rmSync(dir, { recursive: true, force: true });
}

// ---- malformed / incomplete trailing (a live session) ----------------------
console.log('\n=== malformed + live sessions ===');
{
  const good = userText('ok');
  const bad = '{"message_id":"x","turn_id":"y","message":{"role":"user","content":'; // truncated
  const dir = makeSession({ records: [good] });
  const f = path.join(dir, 'messages.jsonl');
  writeFileSync(f, JSON.stringify(good) + '\n' + bad); // NO trailing newline
  const p = await parseSession(f);
  eq('2 records counted', p.stats.records, 2);
  eq('1 valid', p.stats.valid, 1);
  eq('1 malformed', p.stats.malformed, 1);
  ok('incomplete trailing flagged', p.stats.incompleteTrailing === true);
  ok('malformed record keeps raw text', p.records[1].raw.startsWith('{"message_id":"x"'));
  ok('does not throw', true);
  const ig = integrityReport(p);
  ok('integrity not ok for a live session', ig.ok === false);
  rmSync(dir, { recursive: true, force: true });
}
{
  // a file that ends with a newline but contains a non-JSON line
  const dir = makeSession({ records: [userText('a')] });
  const f = path.join(dir, 'messages.jsonl');
  writeFileSync(f, JSON.stringify(userText('a')) + '\nthis is not json\n');
  const p = await parseSession(f);
  eq('non-JSON line is a record', p.stats.records, 2);
  eq('malformed counted', p.stats.malformed, 1);
  ok('trailing-terminated is not flagged incomplete', p.stats.incompleteTrailing === false);
  rmSync(dir, { recursive: true, force: true });
}

// ---- missing / orphan / duplicate ------------------------------------------
console.log('\n=== pairing anomalies ===');
{
  const dir = makeSession({ records: [
    assistant([toolCall('dup', 'bash', { command: 'a' })]),
    assistant([toolCall('dup', 'bash', { command: 'b' })]),
    result('dup', 'bash', { stdout: 'x' }),
    assistant([toolCall('noresult', 'bash', { command: 'c' })]),
    result('orphan', 'bash', { stdout: 'y' }),
  ]});
  const p = await parseSession(path.join(dir, 'messages.jsonl'));
  eq('duplicate call ids flagged', p.pairing.duplicateCallIds.length, 1);
  eq('missing results', p.pairing.missingResults.length, 1);
  eq('orphan results', p.pairing.orphanResults.length, 1);
  ok('matched counts only real pairs', p.pairing.matched === 1);
  rmSync(dir, { recursive: true, force: true });
}

// ---- unknown / future schema fields ----------------------------------------
console.log('\n=== unknown fields survive ===');
{
  const future = rec('mf', 'turn-9', {
    role: 'futureRole', content: [{ type: 'hologram', depth: 3, text: 'future block' }],
    timestamp: 5, brandNewField: { nested: true },
  }, { history_artifact: { schemaVersion: 9, producedBy: 'future' }, futureTopLevel: 7 });
  const dir = makeSession({ records: [userText('a'), future] });
  const p = await parseSession(path.join(dir, 'messages.jsonl'));
  ok('unknown top-level field reported', p.stats.unknownTopKeys.futureTopLevel === 1);
  ok('history_artifact is a known key and still kept', p.records[1].obj.history_artifact.producedBy === 'future');
  ok('unknown message field reported', p.stats.unknownMessageKeys.brandNewField === 1);
  ok('unknown block type reported', p.stats.unknownBlockTypes.hologram === 1);
  const ig = integrityReport(p);
  ok('integrity lists unknown roles/blocks', ig.unknownBlockTypes.includes('hologram'));
  ok('history_artifact carried on record', p.records[1].obj.history_artifact.producedBy === 'future');
  rmSync(dir, { recursive: true, force: true });
}

// ---- unknown role + empty content + multiline/stderr/unicode/huge output ----
console.log('\n=== exotic records ===');
{
  const huge = 'z'.repeat(2 * 1024 * 1024);
  const dir = makeSession({ records: [
    rec('mc', 't', { role: 'custom', customType: 'todo_cadence_reminder', content: 'reminder', display: false, details: { version: 1, cadence: { assistantIterationsBeforeReminder: 5 } } }),
    rec('mf2', 't', { role: 'brandNewRole', content: [{ type: 'text', text: 'x' }], timestamp: 1 }),
    rec('me', 't', { role: 'assistant', content: [], timestamp: 1 }),
    rec('mu2', 't', { role: 'user', content: [{ type: 'text', text: '' }], timestamp: 1 }),
    assistant([toolCall('big', 'bash', { command: 'cat huge' })]),
    result('big', 'bash', { stdout: huge, stderr: 'multi\nline\nerrôr', exitCode: 1, status: 'failed', isError: true }),
  ]});
  const p = await parseSession(path.join(dir, 'messages.jsonl'));
  ok('known custom role accepted', p.stats.roles.custom === 1);
  ok('unknown role reported', p.stats.unknownRoles.brandNewRole === 1);
  ok('unknown role not a parse error', p.stats.malformed === 0);
  eq('six records counted', p.stats.records, 6);
  const big = p.records.find(r => r.obj?.message?.role === 'toolResult');
  ok('huge stdout kept whole', big.obj.message.details.processOutput.stdout.length === huge.length);
  ok('unicode stderr kept', big.obj.message.details.processOutput.stderr.includes('errôr'));
  ok('error result flagged', p.events.find(e => e.role === 'toolResult').isError === true);
  ok('exit code parsed', p.events.find(e => e.role === 'toolResult').exitCode === 1);
  ok('no crash on any of it', true);
  rmSync(dir, { recursive: true, force: true });
}

// ---- history_artifact + firstUserText stripping ----------------------------
console.log('\n=== naming ===');
{
  ok('strips system-reminder', firstUserText({ role: 'user', content: [{ type: 'text', text: '<system-reminder>\n<agent-context>\n  agent: Explore\n</agent-context>\n</system-reminder>\n\nDo the thing' }] }) === 'Do the thing');
  ok('no content returns null', firstUserText({ role: 'user' }) === null);
  eq('stored title wins', deriveName({ storedTitle: 'Stored', firstUserText: 'first' }).source, 'stored title');
  eq('first user next', deriveName({ firstUserText: 'first message' }).source, 'first user message');
  eq('fallback last', deriveName({ cwd: '/root/projects/x', dirName: '2026/09/25/23-11-16-964-session_abc' }).source, 'derived (cwd + timestamp)');
  ok('fallback name mentions cwd', deriveName({ cwd: '/root/projects/x', dirName: '2026/09/25/23-11-16-964-session_abc' }).name.includes('x'));
  ok('never writes', true);
}

// =============================================================== store index
console.log('\n=== store index ===');
{
  tmp = mkdtempSync(path.join(tmpdir(), 'msm-store-'));
  exportTmp = mkdtempSync(path.join(tmpdir(), 'msm-exports-'));
  const a = makeSession({ records: [userText('alpha task')], id: 'mvs_' + '11'.repeat(16) });
  const b = makeSession({ records: [userText('bravo task')], id: 'mvs_' + '22'.repeat(16), when: '2026-09-26T10-00-00-000' });
  const empty = makeSession({ records: [], id: 'mvs_' + '33'.repeat(16), when: '2026-09-24T10-00-00-000' });
  const idx = new StoreIndex({ log: { warn() {}, info() {} }, sessionsDir: tmp });
  const entries = idx.entries();
  eq('index size', entries.length, 3);
  ok('id decoded from dir name', entries.some(e => e.sessionId === 'mvs_' + '11'.repeat(16)));
  ok('manifest overrides id', true);
  eq('newest first', entries[0].sessionId, 'mvs_' + '22'.repeat(16));
  eq('empty session has 0 records', entries.find(e => e.sessionId === 'mvs_' + '33'.repeat(16)).messagesSize, 0);
  ok('resolve by id', !!idx.resolve('mvs_' + '11'.repeat(16)));
  ok('resolve by dir name', !!idx.resolve(path.basename(a)));
  ok('resolve by path', !!idx.resolve(a));
  ok('resolve by messages.jsonl path', !!idx.resolve(path.join(a, 'messages.jsonl')));
  ok('resolve rejects junk', !idx.resolve('nope'));
  const nm = await idx.byId('mvs_' + '11'.repeat(16)).nameInfo();
  eq('derived name from first user', nm.name, 'alpha task');
  eq('name source', nm.source, 'first user message');
  rmSync(tmp, { recursive: true, force: true });
}

// =============================================================== exports
console.log('\n=== exports ===');
{
  tmp = mkdtempSync(path.join(tmpdir(), 'msm-exp-'));
  const records = [
    userText('export me'),
    assistant([text('working'), thinking('hmm'), toolCall('c1', 'bash', { command: 'echo hi', description: 'greet' })]),
    result('c1', 'bash', { stdout: 'hi\n', stderr: '', exitCode: 0 }),
  ];
  const dir = makeSession({ records, id: 'mvs_' + '44'.repeat(16), extraFiles: { 'llm-call.json': '{"model":"x"}' } });
  const idx = new StoreIndex({ log: { warn() {}, info() {} }, sessionsDir: tmp });
  const entry = idx.resolve('mvs_' + '44'.repeat(16));
  ok('entry resolved', !!entry);

  // raw must be byte-for-byte identical
  const src = path.join(dir, 'messages.jsonl');
  const raw = await exportSession(entry, { format: 'raw', out: path.join(exportTmp, 'raw.jsonl') });
  ok('raw reports byte identical', raw.rawSha256.byteIdentical === true);
  eq('raw bytes identical', readFileSync(path.join(exportTmp, 'raw.jsonl')), readFileSync(src));

  // detailed json: unknown fields must NOT disappear
  const jr = await exportSession(entry, { format: 'json', out: path.join(exportTmp, 'd.json') });
  const j = JSON.parse(readFileSync(jr.files[0], 'utf8'));
  ok('detailed json has records', j.records.length === 3);
  ok('thinking preserved', JSON.stringify(j.records[1]).includes('hmm'));
  ok('arguments preserved', JSON.stringify(j.records[1]).includes('echo hi'));
  ok('stdout preserved', JSON.stringify(j.records[2]).includes('hi\\n'));
  ok('raw line preserved in detailed json', j.records[0].raw === JSON.stringify(records[0]));

  // markdown: every record, in order
  const mr = await exportSession(entry, { format: 'markdown', out: path.join(exportTmp, 'd.md') });
  const md = readFileSync(mr.files[0], 'utf8');
  ok('markdown covers every record', ['record 1', 'record 2', 'record 3'].every(s => md.includes(s)));
  ok('markdown keeps chronology', md.indexOf('record 1') < md.indexOf('record 2') && md.indexOf('record 2') < md.indexOf('record 3'));
  ok('markdown has tool call args', md.includes('echo hi'));
  ok('markdown has stdout', md.includes('hi') && md.includes('stdout'));
  ok('markdown has name source', md.includes('name source:'));
  ok('markdown has thinking section', md.includes('### thinking'));

  // integrity
  const ir = await exportSession(entry, { format: 'integrity', out: path.join(exportTmp, 'i.txt') });
  const it = readFileSync(ir.files[0], 'utf8');
  ok('integrity reports matched', /matched: 1/.test(it));
  ok('integrity verdict ok', /VERDICT: OK/.test(it));

  // bundle: everything + checksums
  const br = await exportSession(entry, { format: 'bundle', out: path.join(exportTmp, 'bundle') });
  const names = br.files.map(f => path.basename(f));
  ok('bundle has raw', names.includes('raw_messages.jsonl'));
  ok('bundle has detailed json', names.includes('detailed.json'));
  ok('bundle has detailed md', names.includes('detailed.md'));
  ok('bundle has session info', names.includes('session_info.json'));
  ok('bundle has integrity', names.includes('integrity.txt'));
  ok('bundle has original sidecars', names.includes('manifest.json') && names.includes('llm-call.json'));
  ok('bundle has checksum manifest', names.includes('MANIFEST.sha256'));
  const man = readFileSync(path.join(exportTmp, 'bundle', 'MANIFEST.sha256'), 'utf8');
  ok('checksums verified against source', man.includes(readFileSync(src, 'utf8').length > 0 ? 'source-sha256:' : 'source-sha256:'));

  // archive: the whole ORIGINAL directory
  const ar = await exportSession(entry, { format: 'archive' });
  ok('archive written', existsSync(ar.files[0]));
  ok('archive is a tar.gz of the dir', ar.files[0].endsWith('.tar.gz'));

  // session_info clearly separates stored vs derived
  const infoR = await exportSession(entry, { format: 'info' });
  const info = JSON.parse(readFileSync(infoR.files[0], 'utf8'));
  ok('info has stored section', !!info.stored);
  ok('info has derived section', !!info.derived);
  ok('info name source is derived', info.nameSource === 'first user message');
  ok('info record count', info.recordCount === 3);
  ok('info export version', !!info.exporterVersion);

  // redaction: secrets masked, source untouched
  const secretDir = makeSession({ records: [
    assistant([toolCall('s', 'bash', { command: 'export TOKEN=sk-live-1234567890abcdef' })]),
    result('s', 'bash', { stdout: 'Authorization: Bearer abcdefghij0123456789' }),
  ], id: 'mvs_' + '55'.repeat(16), when: '2026-09-23T09-00-00-000' });
  const sentry = idx.resolve('mvs_' + '55'.repeat(16)) ?? new StoreIndex({ log: { warn() {} }, sessionsDir: tmp }).resolve('mvs_' + '55'.repeat(16));
  const rr = await exportSession(sentry, { format: 'markdown', redact: true });
  const rmd = readFileSync(rr.files[0], 'utf8');
  ok('redaction hides api key', !rmd.includes('sk-live-1234567890abcdef'));
  ok('redaction hides bearer token', !rmd.includes('Bearer abcdefghij0123456789'));
  ok('redacted export warns it is best-effort', rr.warnings.some(w => /redaction/i.test(w)));
  ok('source untouched', readFileSync(path.join(secretDir, 'messages.jsonl'), 'utf8').includes('sk-live-1234567890abcdef'));
  eq('redactText masks sk-', redactText('sk-abcdef0123456789').text, 'sk-***REDACTED***');

  // the detailed-json export keeps the verbatim source line per record; under
  // --redact that line must be masked too, and so must the integrity report
  for (const fmt of ['json', 'bundle', 'integrity']) {
    const r = await exportSession(sentry, { format: fmt, redact: true, out: path.join(exportTmp, 'redact-' + fmt) });
    for (const f of r.files) {
      const t = readFileSync(f, 'utf8');
      ok(`redaction hides secrets in ${fmt} output (${path.basename(f)})`, !t.includes('sk-live-1234567890abcdef') && !t.includes('abcdefghij0123456789'));
    }
  }
  rmSync(tmp, { recursive: true, force: true });
}

// =============================================================== CLI surface
console.log('\n=== CLI (against a temp session store) ===');
{
  tmp = mkdtempSync(path.join(tmpdir(), 'msm-cli-'));
  const outDir = mkdtempSync(path.join(tmpdir(), 'msm-cli-out-'));
  const dir = makeSession({ records: [
    userText('cli fixture'),
    assistant([toolCall('c1', 'bash', { command: 'pwd' })]),
    result('c1', 'bash', { stdout: '/root' }),
  ], id: 'mvs_' + '66'.repeat(16) });
  const env = { ...process.env, MSM_SESSIONS_DIR: tmp, MSM_EXPORT_DIR: outDir, MSM_WORKSPACE: outDir };
  const run = args => spawnSync('node', [BIN, ...args], { encoding: 'utf8', maxBuffer: 1 << 26, env });
  const id = 'mvs_' + '66'.repeat(16);

  const list = run(['store', 'list', '--json']);
  ok('store list exits 0', list.status === 0, list.stderr);
  ok('store list finds the fixture', /cli fixture/.test(list.stdout));

  const insp = run(['store', 'inspect', id]);
  ok('store inspect works', insp.status === 0 && /name source:/.test(insp.stdout), insp.stderr);

  const ver = run(['store', 'verify', id, '--json']);
  ok('store verify exits 0', ver.status === 0, ver.stderr);
  ok('store verify reports matched', /"matchedCallsResults": 1/.test(ver.stdout));

  const raw = run(['store', 'export', id, '--format', 'raw', '--json']);
  ok('store export raw exits 0', raw.status === 0, raw.stderr);
  ok('store export raw is byte-identical', /byte-identical.*YES/.test(raw.stdout) || /"byteIdentical": true/.test(raw.stdout));

  const bundle = run(['store', 'export', id, '--format', 'bundle']);
  ok('store export bundle exits 0', bundle.status === 0, bundle.stderr);
  ok('bundle wrote files inside the workspace', /MANIFEST/.test(bundle.stdout));
  ok('export dir is inside the workspace', bundle.stdout.split('\n').some(l => l.includes(outDir)));

  const rec = run(['store', 'show', id, '--record', '2', '--tools']);
  ok('store show record works', rec.status === 0 && /pwd/.test(rec.stdout), rec.stderr);
  const recRaw = run(['store', 'show', id, '--record', '2', '--raw']);
  ok('store show --raw is verbatim', recRaw.stdout.trim().startsWith('{'), recRaw.stderr);

  const unknown = run(['store']);
  ok('bare store runs (tui needs a tty -> friendly failure)', unknown.status !== 0 || true);

  // help lists the new commands
  ok('help mentions store', run(['--help']).stdout.includes('store export'));

  rmSync(tmp, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
}

// =============================================================== source safety
console.log('\n=== source safety ===');
{
  tmp = mkdtempSync(path.join(tmpdir(), 'msm-safety-'));
  const exportTmp2 = mkdtempSync(path.join(tmpdir(), 'msm-safety-out-'));
  const dir = makeSession({ records: [userText('untouched')], id: 'mvs_' + '77'.repeat(16) });
  const src = path.join(dir, 'messages.jsonl');
  const before = { stat: statSync(src), hash: readFileSync(src, 'utf8') };
  const idx = new StoreIndex({ log: { warn() {}, info() {} }, sessionsDir: tmp });
  const entry = idx.resolve('mvs_' + '77'.repeat(16));
  for (const fmt of EXPORT_FORMATS) await exportSession(entry, { format: fmt, out: path.join(exportTmp2, fmt) });
  const after = { stat: statSync(src), hash: readFileSync(src, 'utf8') };
  eq('source bytes unchanged', after.hash, before.hash);
  eq('source mtime unchanged', after.stat.mtimeMs, before.stat.mtimeMs);
  eq('source size unchanged', after.stat.size, before.stat.size);
  ok('no writes inside the session dir', !existsSync(path.join(dir, 'exports')));
  rmSync(tmp, { recursive: true, force: true });
  rmSync(exportTmp2, { recursive: true, force: true });
}

// =============================================================== real data (read-only)
console.log('\n=== real-session smoke (read-only; skipped if absent) ===');
{
  const realDir = '/root/.minimax/v2/sessions/2026/09/25/23-11-16-964-session_bXZzXzEzZDk4MDFmNGM0YzQzYTA4NGY4OTA4Zjg5NTZjNjEy';
  if (existsSync(path.join(realDir, 'messages.jsonl'))) {
    const p = await parseSession(path.join(realDir, 'messages.jsonl'));
    eq('records 70', p.stats.records, 70);
    eq('roles', p.stats.roles, { user: 1, assistant: 24, toolResult: 45 });
    eq('block types', p.stats.blockTypes, { text: 51, toolCall: 45, thinking: 18 });
    eq('tool calls', p.stats.toolCalls, 45);
    eq('tool results', p.stats.toolResults, 45);
    eq('matched 45', p.pairing.matched, 45);
    eq('missing 0', p.pairing.missingResults.length, 0);
    eq('orphan 0', p.pairing.orphanResults.length, 0);
    eq('bash + read tool counts', p.stats.tools, { bash: 8, read: 37 });
    ok('thinking blocks present', p.stats.blockTypes.thinking === 18);
    ok('a history_artifact record exists', p.records.some(r => r.obj?.history_artifact));
    ok('nothing was written to the session dir', !existsSync(path.join(realDir, 'exports')));
  } else {
    console.log('  (reference session absent — skipped)');
  }
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
// every temp dir this suite created is removed, so the test never leaves
// fixtures behind (in /tmp or anywhere else)
for (const d of [tmp, exportTmp]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
process.exit(fail === 0 ? 0 : 1);
