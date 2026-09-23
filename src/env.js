// Environment resolution: paths, runtime flags. No global env mutation.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const MCODE_INSTALL_ROOT = process.env.MSM_MCODE_ROOT || '/root/.minimax-code';

// Pick the newest installed release under releases/ (semver-ish numeric sort)
// so a tool upgrade of mcode does not silently point at a stale hardcode.
function discoverRelease() {
  try {
    const dir = path.join(MCODE_INSTALL_ROOT, 'releases');
    const names = readdirSync(dir).filter(n => /^\d+\.\d+\.\d+$/.test(n));
    if (!names.length) return '0.5.2';
    names.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    });
    return names[names.length - 1];
  } catch { return '0.5.2'; }
}

export const MCODE_RELEASE = process.env.MSM_MCODE_RELEASE || discoverRelease();
export const MCODE_PKG = path.join(
  MCODE_INSTALL_ROOT, 'releases', MCODE_RELEASE,
  'lib', 'node_modules', '@minimax-ai', 'code'
);
export const MCODE_CLI_JS = path.join(MCODE_PKG, 'cli.js'); // used to require better-sqlite3
export const MCODE_BIN = path.join(MCODE_INSTALL_ROOT, 'bin', 'mcode');

export const RUNTIME_DATA_DIR = process.env.MSM_RUNTIME_DATA_DIR || '/root/.minimax';
export const DB_PATH = path.join(RUNTIME_DATA_DIR, 'v2', 'sqlite', 'runtime-state.sqlite');

// Our own state lives OUTSIDE the MiniMax database.
export const MSM_DIR = process.env.MSM_HOME || path.join(homedir(), '.mcode-session-manager');
export const MSM_LOG_DIR = path.join(MSM_DIR, 'logs');
export const MSM_BACKUP_DIR = path.join(MSM_DIR, 'backups');
export const MSM_BACKUP_KEEP = envInt('MSM_BACKUP_KEEP', 5);

export const SESSION_ID_PREFIX = 'mvs_';

function envInt(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

// Parse the long/short flags this tool understands. Non-global; returned only.
// Supports `--flag value`, `--flag=value`, and `-s value`. Unknown flags are
// collected (not silently dropped one-at-a-time) so the CLI can warn once.
export function parseFlags(argv) {
  const f = {
    debug: false, verbose: false, color: true,
    dryRun: false, confirm: false, nonInteractive: false,
    noBackup: false, ascii: false, session: null,
    help: false, version: false,
    includeArchived: true, onlyArchived: false,
    json: false,
    format: null, status: null, kind: null, workspace: null,
    cwd: null, limit: null, offset: null, out: null, parent: null,
    messages: false,
    unknown: [],
  };
  const positional = [];

  // value-taking flag: returns the value and does not advance i for `=` form
  const valueOf = (i, a, long, short) => {
    if (a === long || a === short) return { value: argv[++i], i };
    if (a.startsWith(long + '=')) return { value: a.slice(long.length + 1), i };
    return null;
  };
  const intOf = v => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a === '-h' || a === '--help') { f.help = true; continue; }
    if (a === '-V' || a === '--version') { f.version = true; continue; }
    if (a === '--debug') { f.debug = true; continue; }
    if (a === '--verbose') { f.verbose = true; f.debug = true; continue; }
    if (a === '--no-color') { f.color = false; continue; }
    if (a === '--dry-run') { f.dryRun = true; continue; }
    if (a === '--confirm' || a === '--yes') { f.confirm = true; continue; }
    if (a === '--non-interactive') { f.nonInteractive = true; continue; }
    if (a === '--no-backup') { f.noBackup = true; continue; }
    if (a === '--ascii') { f.ascii = true; continue; }
    if (a === '--json') { f.json = true; continue; }
    if (a === '--messages' || a === '-m') { f.messages = true; continue; }
    if (a === '--archived' || a === '--include-archived') { f.includeArchived = true; f.onlyArchived = false; continue; }
    if (a === '--no-archived' || a === '--exclude-archived') { f.includeArchived = false; f.onlyArchived = false; continue; }
    if (a === '--only-archived') { f.onlyArchived = true; f.includeArchived = true; continue; }

    let m;
    if ((m = valueOf(i, a, '--session', '-s')) !== null) { f.session = String(m.value ?? ''); i = m.i; continue; }
    if ((m = valueOf(i, a, '--format', '-f')) !== null) { f.format = String(m.value ?? ''); i = m.i; continue; }
    if ((m = valueOf(i, a, '--status', null)) !== null) { f.status = String(m.value ?? ''); i = m.i; continue; }
    if ((m = valueOf(i, a, '--kind', '-k')) !== null) { f.kind = String(m.value ?? ''); i = m.i; continue; }
    if ((m = valueOf(i, a, '--workspace', '-w')) !== null) { f.workspace = String(m.value ?? ''); i = m.i; continue; }
    if ((m = valueOf(i, a, '--cwd', '-c')) !== null) { f.cwd = String(m.value ?? ''); i = m.i; continue; }
    if ((m = valueOf(i, a, '--out', '-o')) !== null) { f.out = String(m.value ?? ''); i = m.i; continue; }
    if ((m = valueOf(i, a, '--parent', '-p')) !== null) { f.parent = String(m.value ?? ''); i = m.i; continue; }
    if ((m = valueOf(i, a, '--limit', '-n')) !== null) { f.limit = intOf(m.value); i = m.i; continue; }
    if ((m = valueOf(i, a, '--offset', null)) !== null) { f.offset = intOf(m.value); i = m.i; continue; }

    if (a.startsWith('-') && a !== '-') { f.unknown.push(a); continue; }
    positional.push(a);
  }
  return { flags: f, positional };
}

export function mcodeVersion() {
  try {
    const p = JSON.parse(readFileSync(path.join(MCODE_PKG, 'package.json'), 'utf8'));
    return p.version;
  } catch { return MCODE_RELEASE; }
}

export function dbExists() { return existsSync(DB_PATH); }
export function mcodeBinExists() { return existsSync(MCODE_BIN); }
