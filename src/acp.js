// ACP adapter: native MiniMax runtime/lifecycle operations over JSON-RPC (stdio).
// This is the *real* runtime interface (see RESEARCH.md). It owns: list, fork,
// new, load, resume, close, setMode. It does NOT implement delete/archive/rename.
import { spawn } from 'node:child_process';
import { MCODE_BIN } from './env.js';

const PROTOCOL_VERSION = 1;
const ACP_TIMEOUT_MS = 20000;
const KILL_GRACE_MS = 2000;

export class AcpClient {
  constructor({ log, bin = MCODE_BIN, spawnArgs = ['acp'] } = {}) {
    this.log = log;
    this.bin = bin;
    this.spawnArgs = spawnArgs;
    this.child = null;
    this._buf = Buffer.alloc(0);
    this._pending = new Map();
    this._nextId = 1;
    this.initialized = false;
  }

  _start() {
    if (this.child) return;
    this.log?.verbose(`spawning acp server: ${this.bin} ${this.spawnArgs.join(' ')}`);
    const child = spawn(this.bin, this.spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', d => this._onData(d));
    child.on('error', e => { this.log?.warn(`acp child error: ${e.message}`); this._failAll(e); });
    child.stdin.on('error', e => { this.log?.warn(`acp stdin error: ${e.message}`); this._failAll(e); });
    child.on('exit', (code, sig) => {
      this.log?.verbose(`acp server exited code=${code} sig=${sig}`);
      this._failAll(new Error(`ACP server exited (code=${code})`));
      this.child = null;
    });
  }

  _onData(d) {
    this._buf = Buffer.concat([this._buf, d]);
    let idx;
    while ((idx = this._buf.indexOf(10)) >= 0) {
      const line = this._buf.slice(0, idx).toString('utf8').trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id != null && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(Object.assign(new Error('ACP error: ' + (msg.error.message ?? JSON.stringify(msg.error))), { error: msg.error }));
        else resolve(msg.result);
      }
    }
  }

  _failAll(err) {
    for (const [, p] of this._pending) { p.reject(err); }
    this._pending.clear();
  }

  _send(method, params) {
    this._start();
    const id = this._nextId++;
    const p = new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (e) {
      this._pending.delete(id);
      return Promise.reject(e);
    }
    return p;
  }

  async _call(method, params, ms = ACP_TIMEOUT_MS) {
    // Clear the timer on settle: an unref'd-but-live setTimeout would otherwise
    // keep the process alive for up to `ms` after every ACP call returns.
    let timer = null;
    try {
      return await Promise.race([
        this._send(method, params ?? {}),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`ACP timeout: ${method}`)), ms); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async initialize() {
    if (this.initialized) return;
    const res = await this._call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'mcode-session-manager', version: '1.1.0' },
    });
    this.serverInfo = res?.agentInfo ?? {};
    this.initialized = true;
    this.log?.verbose(`acp initialized: ${JSON.stringify(this.serverInfo)}`);
  }

  // native list; includeArchived is always true server-side
  async listSessions({ cwd, cursor } = {}) {
    await this.initialize();
    const params = {};
    if (cwd) params.cwd = cwd;
    if (cursor) params.cursor = cursor;
    return this._call('session/list', params);
  }

  async newSession({ cwd, mcpServers = [] } = {}) {
    await this.initialize();
    return this._call('session/new', { cwd, mcpServers });
  }

  async forkSession({ sessionId, cwd, mcpServers, additionalDirectories } = {}) {
    await this.initialize();
    const params = { sessionId, cwd };
    if (mcpServers) params.mcpServers = mcpServers;
    if (additionalDirectories) params.additionalDirectories = additionalDirectories;
    return this._call('session/fork', params);
  }

  async loadSession({ sessionId, cwd, mcpServers = [] } = {}) {
    await this.initialize();
    return this._call('session/load', { sessionId, cwd, mcpServers });
  }

  async close() {
    const c = this.child;
    this.child = null;
    this.initialized = false;
    this._buf = Buffer.alloc(0);
    this._failAll(new Error('ACP client closed'));
    if (!c) return;
    try { c.kill('SIGTERM'); } catch { /* already gone */ }
    // escalate if the server ignores SIGTERM, without blocking close forever
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
    if (typeof t.unref === 'function') t.unref();
  }
}

// One-shot helper: run an ACP op with an auto-closed client.
export async function withAcp(log, fn, opts = {}) {
  const acp = new AcpClient({ log, ...opts });
  try { return await fn(acp); } finally { await acp.close(); }
}
