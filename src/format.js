// Shared text/age formatting used by both the CLI and the TUI (single source
// of truth so the two surfaces never drift apart).
import { dispWidth, clipTo, padTo } from './theme.js';

export { dispWidth, clipTo, padTo };

export function trunc(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
}

export function shortWs(w) {
  if (!w) return '';
  const p = String(w).split('/');
  return p[p.length - 1] || w;
}

export function relAge(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.round(s / 86400 / 30)}mo`;
  return `${Math.round(s / 86400 / 365)}y`;
}

export function iso(ms) {
  if (ms == null) return '?';
  const n = Number(ms);
  if (!Number.isFinite(n)) return '?';
  try { return new Date(n).toISOString(); } catch { return String(n); }
}

// Escape LIKE metacharacters so user text is matched literally.
export function escapeLike(s) {
  return String(s ?? '').replace(/[\\%_]/g, m => '\\' + m);
}

// Greedy word-wrap that preserves leading indentation and never exceeds
// `width` display columns. Used for --help and any long human-facing lines.
export function wrapText(text, width, { hang: hangOpt = null } = {}) {
  if (!(width > 0)) return String(text ?? '');
  return String(text ?? '').split('\n').map(line => {
    if (dispWidth(line) <= width) return line;
    const m = /^([ \t]*)(.*)$/.exec(line);
    // never let the indent itself eat the whole width
    let indent = m[1];
    if (dispWidth(indent) > Math.max(0, width - 4)) {
      indent = ' '.repeat(Math.min(dispWidth(indent), Math.max(0, width >> 2)));
    }
    const hangBase = hangOpt != null ? hangOpt : indent;
    const hang = dispWidth(String(hangBase)) > Math.max(0, width - 4)
      ? ' '.repeat(Math.max(0, Math.min(width >> 2, width - 4)))
      : String(hangBase);
    const hangW = dispWidth(hang);
    const budget = Math.max(1, width - hangW);
    const words = m[2].split(/([ \t]+)/).filter(Boolean);
    const lines = [];
    let cur = indent;
    let curW = dispWidth(indent);
    const push = () => { lines.push(cur.replace(/[ \t]+$/, '')); cur = hang; curW = hangW; };
    for (const w of words) {
      if (/^[ \t]+$/.test(w)) {
        if (cur.trimEnd() !== cur || cur === indent) continue;
        cur += w; curW += dispWidth(w);
        continue;
      }
      const wW = dispWidth(w);
      if (wW > budget) {
        // hard-break a single overlong token (paths, flags, URLs)
        if (cur.trim()) push();
        let chunk = '';
        for (const ch of w) {
          if (dispWidth(chunk) + 1 > budget) { // ch is at most 2 cells; use dispWidth
            if (chunk) { lines.push(hang + chunk); }
            chunk = '';
          }
          if (dispWidth(chunk + ch) > budget) {
            if (chunk) { lines.push(hang + chunk); chunk = ch; }
            else chunk = ch;
          } else chunk += ch;
        }
        cur = hang + chunk;
        curW = hangW + dispWidth(chunk);
        continue;
      }
      if (curW + wW > width && cur.trim()) {
        push();
        cur += w; curW += wW;
      } else {
        cur += w; curW += wW;
      }
    }
    if (cur.trim() || !lines.length) lines.push(cur.replace(/[ \t]+$/, ''));
    return lines.join('\n');
  }).join('\n');
}

// Right-align helper: pad a display-width string on the left.
export function padStartW(s, w, fill = ' ') {
  const t = String(s ?? '');
  const pad = Math.max(0, w - dispWidth(t));
  return fill.repeat(pad) + t;
}

// Join a left and right segment with spaces filling the middle to exactly `w`.
export function fitLR(left, right, w) {
  const l = String(left ?? '');
  const r = String(right ?? '');
  const lw = dispWidth(l);
  const rw = dispWidth(r);
  if (lw + rw >= w) return clipTo(l + r, w);
  return l + ' '.repeat(w - lw - rw) + r;
}
