// Theme resolution that mirrors MiniMax Code's OWN `minimax` theme.
//
// The hex values below are copied verbatim from mcode 0.5.2's bundled theme
// definitions (chunks/launcher-BKHZAKO7.js: the `minimax` dark/light color
// maps, their 16-colour fallback table, and the COLORFGBG luminance probe).
// mcode applies them through picocolors with a truecolor -> 256 -> 16
// degradation ladder; this module reproduces that same ladder so the session
// manager renders with mcode's real colours on any terminal.
//
// Theme choice mirrors mcode too: the active theme name is read from mcode's
// own settings file (<runtime data dir>/tui/tui-settings.json), and light/dark
// is resolved from COLORFGBG luminance exactly as mcode does it. Only the
// `minimax` theme is bundled here; an unknown name falls back to it.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RUNTIME_DATA_DIR } from './env.js';

// the themes bundled into this tool (mcode ships more; we mirror the default)
const KNOWN_THEMES = new Set(['minimax']);

function readMcodeThemeName(dataDir) {
  const file = path.join(dataDir, 'tui', 'tui-settings.json');
  try {
    if (!existsSync(file)) return 'minimax';
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
    const obj = JSON.parse(raw);
    const name = typeof obj?.theme === 'string' ? obj.theme : 'minimax';
    return KNOWN_THEMES.has(name) ? name : 'minimax';
  } catch { return 'minimax'; }
}

// mcode `minimax` palette. Keys are mcode's own colour-role names.
const HEX = {
  dark: {
    brand: '#68C0FF', signal: '#68C0FF', orbit: '#1CCDD2', accent: '#68C0FF',
    text: '#D6D6D6', muted: '#ADADAD', dim: '#666666',
    border: '#303030', line: '#666666',
    success: '#28C567', warning: '#FFC340', error: '#FF5E6C',
    selectedBg: '#262626',          // mcode `userMessageBg`
    diffAdded: '#213A2B', diffRemoved: '#4A221D',
    heading: '#CBA6F7', code: '#A6E3A1',
  },
  light: {
    brand: '#0094FC', signal: '#0094FC', orbit: '#00767D', accent: '#0094FC',
    text: '#303030', muted: '#666666', dim: '#949494',
    border: '#EDEDED', line: '#949494',
    success: '#008635', warning: '#916300', error: '#E31937',
    selectedBg: '#F5F5F5',
    diffAdded: '#DAFBE1', diffRemoved: '#FFEBE9',
    heading: '#8839EF', code: '#267A3F',
  },
};

// mcode's 16-colour fallback for terminals without 256/truecolor support
// (its `e8` table: dark -> named picocolors, light -> named picocolors).
const NAMED16 = {
  dark: { brand: 'cyan', signal: 'cyan', orbit: 'cyan', accent: 'cyan',
    text: 'default', muted: 'defaultDim', dim: 'gray', border: 'gray', line: 'gray',
    success: 'greenBright', warning: 'yellowBright', error: 'redBright',
    selectedBg: 'bgGray', heading: 'magentaBright', code: 'greenBright' },
  light: { brand: 'blueBright', signal: 'blueBright', orbit: 'cyan', accent: 'blueBright',
    text: 'default', muted: 'defaultDim', dim: 'gray', border: 'gray', line: 'gray',
    success: 'green', warning: 'yellow', error: 'red',
    selectedBg: 'bgBrightWhite', heading: 'magenta', code: 'green' },
};

// SGR codes for the named colours above (foreground unless prefixed bg).
const SGR16 = {
  default: '', defaultDim: '\x1b[2m',
  black: '\x1b[30m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
  redBright: '\x1b[91m', greenBright: '\x1b[92m', yellowBright: '\x1b[93m',
  blueBright: '\x1b[94m', magentaBright: '\x1b[95m', cyanBright: '\x1b[96m',
  whiteBright: '\x1b[97m',
  bgGray: '\x1b[100m', bgBrightWhite: '\x1b[107m',
};

// Standard ANSI-16 palette, used to interpret COLORFGBG (mcode's own table).
const ANSI16_RGB = [
  { r: 0, g: 0, b: 0 }, { r: 128, g: 0, b: 0 }, { r: 0, g: 128, b: 0 }, { r: 128, g: 128, b: 0 },
  { r: 0, g: 0, b: 128 }, { r: 128, g: 0, b: 128 }, { r: 0, g: 128, b: 128 }, { r: 192, g: 192, b: 192 },
  { r: 128, g: 128, b: 128 }, { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 255, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 }, { r: 255, g: 0, b: 255 }, { r: 0, g: 255, b: 255 }, { r: 255, g: 255, b: 255 },
];

function colorDepth() {
  try { return typeof process.stdout.getColorDepth === 'function' ? process.stdout.getColorDepth() : 1; }
  catch { return 1; }
}

// mcode: appearance from COLORFGBG via relative luminance; defaults to dark.
function colorfgbgAppearance(env) {
  const raw = env.COLORFGBG;
  if (!raw) return 'dark';
  const last = raw.split(';').at(-1)?.trim();
  if (!last || !/^\d{1,3}$/.test(last)) return 'dark';
  const n = Number(last);
  if (!Number.isInteger(n) || n < 0 || n > 255) return 'dark';
  return luminance(ansi256ToRgb(n)) >= 0.5 ? 'light' : 'dark';
}
function luminance({ r, g, b }) {
  const ch = v => { const n = Math.max(0, Math.min(255, v)) / 255; return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
function ansi256ToRgb(n) {
  const base = ANSI16_RGB[n];
  if (base) return base;
  if (n >= 232) { const v = 8 + (n - 232) * 10; return { r: v, g: v, b: v }; }
  const t = n - 16, i = Math.floor(t / 36), s = Math.floor(t % 36 / 6), r = t % 6;
  const f = v => v === 0 ? 0 : 55 + v * 40;
  return { r: f(i), g: f(s), b: f(r) };
}
function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToAnsi256({ r, g, b }) {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : Math.round((r - 8) / 247 * 24) + 232;
  return 16 + 36 * Math.round(r / 255 * 5) + 6 * Math.round(g / 255 * 5) + Math.round(b / 255 * 5);
}

export class Theme {
  constructor({ color = true, env = process.env, dataDir = RUNTIME_DATA_DIR } = {}) {
    this.on = !!color && env.NO_COLOR == null;
    this.depth = this.on ? colorDepth() : 1;
    const override = typeof env.MSM_THEME_NAME === 'string' ? env.MSM_THEME_NAME : null;
    this.name = (override && KNOWN_THEMES.has(override)) ? override : readMcodeThemeName(dataDir);
    this.appearance = env.MSM_THEME === 'light' ? 'light'
      : env.MSM_THEME === 'dark' ? 'dark'
        : colorfgbgAppearance(env);
    this.hex = HEX[this.appearance];
    this.named = NAMED16[this.appearance];
  }
  // resolve a colour-role name to an SGR opener (foreground by default)
  _open(role, bg = false) {
    if (!this.on || !role) return '';
    if (this.depth >= 24) {
      const c = hexToRgb(this.hex[role] ?? this.hex.text);
      return bg ? `\x1b[48;2;${c.r};${c.g};${c.b}m` : `\x1b[38;2;${c.r};${c.g};${c.b}m`;
    }
    if (this.depth === 8) {
      const n = rgbToAnsi256(hexToRgb(this.hex[role] ?? this.hex.text));
      return bg ? `\x1b[48;5;${n}m` : `\x1b[38;5;${n}m`;
    }
    if (this.depth === 4) {
      const named = this.named[role];
      if (!named || named === 'default') return '';
      if (named === 'defaultDim') return '\x1b[2m';
      if (named.startsWith('bg')) return SGR16[named] ?? '';
      return SGR16[named] ?? '';
    }
    return '';
  }
  // one composable opener + single reset; attrs: {fg,bg,bold,dim,italic}
  style(spec, text) {
    const t = String(text ?? '');
    // colourising an EMPTY span emits a full SGR open+close around nothing:
    // it has no visual effect at all, only bytes. Eliding it keeps frames
    // small (rows have several optional fields that are often empty) so a full
    // repaint stays under the tty output buffer and never lands as a
    // half-painted frame.
    if (!this.on || t === '') return t;
    const parts = [];
    if (spec.bold) parts.push('\x1b[1m');
    if (spec.dim) parts.push('\x1b[2m');
    if (spec.italic) parts.push('\x1b[3m');
    if (spec.fg) { const o = this._open(spec.fg); if (o) parts.push(o); }
    if (spec.bg) { const o = this._open(spec.bg, true); if (o) parts.push(o); }
    if (!parts.length) return t;
    return parts.join('') + t + '\x1b[0m';
  }
  fg(role, text) { return this.style({ fg: role }, text); }
  bg(role, text) { return this.style({ bg: role }, text); }
  bold(text) { return this.style({ bold: true }, text); }
  dim(text) { return this.style({ dim: true }, text); }
}

// display width of a string ignoring ANSI escapes (approximates wcwidth:
// CJK/emoji-wide code points count as 2)
export function dispWidth(s) {
  let n = 0;
  for (const ch of String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) {
    const cp = ch.codePointAt(0) ?? 0;
    n += (cp >= 0x1100 && (cp <= 0x115F || cp === 0x2329 || cp === 0x232A ||
      (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) || (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE10 && cp <= 0xFE19) ||
      (cp >= 0xFE30 && cp <= 0xFE6F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1FAFF) ||
      (cp >= 0x1F900 && cp <= 0x1F9FF))) ? 2 : 1;
  }
  return n;
}
export function padTo(s, w, fill = ' ') {
  const pad = Math.max(0, w - dispWidth(s));
  return String(s) + fill.repeat(pad);
}

// Truncate to a maximum *display* width while preserving ANSI SGR sequences.
// A TUI that paints with absolute cursor addressing must never emit a line
// wider than the terminal: one soft-wrap shifts every later row and leaves
// stale glyphs (double cursors, stacked footers) that diff-repaints never fix.
export function clipTo(s, maxW) {
  if (!(maxW > 0)) return '';
  const str = String(s ?? '');
  if (dispWidth(str) <= maxW) return str;
  let w = 0;
  let out = '';
  let i = 0;
  let clipped = false;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
      i += 1; // stray ESC — drop
      continue;
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = dispWidth(ch);
    if (w + cw > maxW) { clipped = true; break; }
    out += ch;
    w += cw;
    i += ch.length;
  }
  // if we cut mid-style, close the SGR so colour cannot bleed into the next cell
  if (clipped && str.includes('\x1b')) out += '\x1b[0m';
  return out;
}
