// Logger: writes to ~/.mcode-session-manager/logs/, never to the MiniMax DB.
// Size-capped with simple rotation so --debug sessions cannot fill the disk.
import { mkdirSync, appendFileSync, statSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { MSM_LOG_DIR } from './env.js';

const MAX_LOG_BYTES = 1024 * 1024; // rotate once the active log passes 1 MiB
const KEEP_ROTATED = 3;            // msm.log.1 .. msm.log.3

let dirEnsured = false;
function ensureDir() {
  if (!dirEnsured) { mkdirSync(MSM_LOG_DIR, { recursive: true }); dirEnsured = true; }
}

const LEVELS = { error: 0, warn: 1, info: 2, verbose: 3, debug: 4 };

export class Logger {
  constructor({ level = 'info' } = {}) {
    this.level = typeof level === 'number' ? level : (LEVELS[level] ?? LEVELS.info);
    this.file = path.join(MSM_LOG_DIR, 'msm.log');
  }
  _rotate() {
    try {
      if (!existsSync(this.file) || statSync(this.file).size < MAX_LOG_BYTES) return;
      for (let i = KEEP_ROTATED - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (existsSync(from)) renameSync(from, to);
      }
      renameSync(this.file, `${this.file}.1`);
    } catch { /* never break the caller over log hygiene */ }
  }
  _write(lvl, msg) {
    const n = LEVELS[lvl] ?? 2;
    if (n > this.level) return;
    ensureDir();
    this._rotate();
    const line = `${new Date().toISOString()} [${lvl}] ${msg}\n`;
    try { appendFileSync(this.file, line); } catch { /* never break */ }
  }
  error(m) { this._write('error', m); }
  warn(m) { this._write('warn', m); }
  info(m) { this._write('info', m); }
  verbose(m) { this._write('verbose', m); }
  debug(m) { this._write('debug', m); }
}
