// Logger: writes to ~/.mcode-session-manager/logs/, never to the MiniMax DB.
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { MSM_LOG_DIR } from './env.js';

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
  _write(lvl, msg) {
    const n = LEVELS[lvl] ?? 2;
    if (n > this.level) return;
    ensureDir();
    const line = `${new Date().toISOString()} [${lvl}] ${msg}\n`;
    try { appendFileSync(this.file, msg.split('\n')[0] === undefined ? line : line); } catch { /* never break */ }
  }
  error(m) { this._write('error', m); }
  warn(m) { this._write('warn', m); }
  info(m) { this._write('info', m); }
  verbose(m) { this._write('verbose', m); }
  debug(m) { this._write('debug', m); }
}
