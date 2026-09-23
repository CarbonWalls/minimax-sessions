// Environment resolution: paths, runtime flags. No global env mutation.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const MCODE_INSTALL_ROOT = '/root/.minimax-code';
export const MCODE_RELEASE = '0.5.2';
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

export const SESSION_ID_PREFIX = 'mvs_';

// Parse the long/short flags this tool understands. Non-global; returned only.
export function parseFlags(argv) {
  const f = {
    debug: false, verbose: false, color: true,
    dryRun: false, confirm: false, nonInteractive: false,
    noBackup: false, ascii: false, session: null,
    help: false, version: false,
    includeArchived: true,
    json: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-h' || a === '--help') f.help = true;
    else if (a === '-V' || a === '--version') f.version = true;
    else if (a === '--debug') f.debug = true;
    else if (a === '--verbose') { f.verbose = true; f.debug = true; }
    else if (a === '--no-color') f.color = false;
    else if (a === '--dry-run') f.dryRun = true;
    else if (a === '--confirm') f.confirm = true;
    else if (a === '--yes') f.confirm = true;
    else if (a === '--non-interactive') f.nonInteractive = true;
    else if (a === '--no-backup') f.noBackup = true;
    else if (a === '--ascii') f.ascii = true;
    else if (a === '--archived' || a === '--include-archived') f.includeArchived = true;
    else if (a === '--no-archived' || a === '--exclude-archived') f.includeArchived = false;
    else if (a === '--json') f.json = true;
    else if (a === '--session' || a === '-s') f.session = String(next() ?? '');
    else if (a.startsWith('--session=')) f.session = a.slice('--session='.length);
    else if (a.startsWith('-') && a !== '-') { /* unknown flag: ignore, but note */ f._unknown = a; }
    else positional.push(a);
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
