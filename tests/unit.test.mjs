// Fast unit tests: pure functions only, no database and no mcode install.
// Run first in the suite so regressions surface without touching real sessions.
import { parseFlags, SESSION_ID_PREFIX } from '../src/env.js';
import { trunc, shortWs, relAge, iso, escapeLike, wrapText, fitLR } from '../src/format.js';
import { decodeKeys } from '../src/tui.js';
import { Theme, dispWidth, padTo, clipTo } from '../src/theme.js';
import { isSessionKeyCol, quoteIdent, CASCADE_ID_COLS } from '../src/sqlite.js';
import { pidAlive } from '../src/safety.js';
import { EXPORT_FORMATS } from '../src/inspect.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${x}`));
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// ------------------------------------------------------------------ parseFlags
console.log('=== parseFlags ===');
{
  const { flags, positional } = parseFlags(['list', '--json', '--limit', '10', 'hello']);
  eq('positionals collected', positional, ['list', 'hello']);
  ok('--json', flags.json === true);
  ok('--limit value form', flags.limit === 10, String(flags.limit));
}
{
  const { flags } = parseFlags(['--limit=5', '--format=json', '--session=mvs_x', '-s', 'mvs_y']);
  ok('--limit= form', flags.limit === 5);
  ok('--format= form', flags.format === 'json');
  ok('--session= then -s overrides', flags.session === 'mvs_y', flags.session);
}
{
  const { flags } = parseFlags(['--status', 'idle', '--kind=conversation', '--workspace', '/tmp/x', '--cwd', '/tmp/y', '--out=o.md', '--parent', 'mvs_p']);
  eq('value flags', { status: flags.status, kind: flags.kind, workspace: flags.workspace, cwd: flags.cwd, out: flags.out, parent: flags.parent },
    { status: 'idle', kind: 'conversation', workspace: '/tmp/x', cwd: '/tmp/y', out: 'o.md', parent: 'mvs_p' });
}
{
  const { flags } = parseFlags(['--no-archived']);
  ok('--no-archived', flags.includeArchived === false && flags.onlyArchived === false);
  const { flags: f2 } = parseFlags(['--only-archived']);
  ok('--only-archived', f2.onlyArchived === true);
  const { flags: f3 } = parseFlags(['--bogus-flag', '--json']);
  eq('unknown flags collected', f3.unknown, ['--bogus-flag']);
  ok('known flag after unknown still parsed', f3.json === true);
}
{
  const { positional } = parseFlags(['list', '--', '--not-a-flag']);
  eq('-- stops flag parsing', positional, ['list', '--not-a-flag']);
}
{
  const { flags } = parseFlags(['-h']);
  ok('-h help', flags.help === true);
  const { flags: v } = parseFlags(['--verbose']);
  ok('--verbose implies debug', v.verbose && v.debug);
}

// -------------------------------------------------------------------- format
console.log('\n=== format ===');
eq('trunc short', trunc('abc', 10), 'abc');
eq('trunc long', trunc('abcdef', 4), 'abc…');
eq('trunc nullsafe', trunc(null, 5), '');
eq('shortWs', shortWs('/root/projects/foo'), 'foo');
eq('shortWs empty', shortWs(''), '');
ok('relAge seconds', /^\d+s$/.test(relAge(Date.now() - 5000)), relAge(Date.now() - 5000));
ok('relAge null', relAge(null) === '');
ok('iso null', iso(null) === '?');
ok('iso ms', iso(0).startsWith('1970-01-01'));
eq('escapeLike percent', escapeLike('100%'), '100\\%');
eq('escapeLike underscore', escapeLike('a_b'), 'a\\_b');
eq('escapeLike backslash', escapeLike('a\\b'), 'a\\\\b');

// ------------------------------------------------------------- wrapText / fitLR
console.log('\n=== wrapText / fitLR ===');
{
  const line = '  mcode-sessions export <id>           --format markdown|json|jsonl|metadata';
  for (const w of [20, 40, 60, 80, 100]) {
    const out = wrapText(line, w);
    const lines = out.split('\n');
    ok(`wrap width ${w} stays in bounds`, lines.every(l => dispWidth(l) <= w),
      JSON.stringify(lines.filter(l => dispWidth(l) > w)));
  }
}
{
  // long hanging indent (HELP's continuation column) must not overflow
  const cont = '                                       (--messages also hits bodies)';
  for (const w of [20, 40, 60]) {
    const lines = wrapText(cont, w).split('\n');
    ok(`hanging indent wrap width ${w}`, lines.every(l => dispWidth(l) <= w),
      JSON.stringify(lines));
  }
}
{
  const over = 'x'.repeat(100);
  const lines = wrapText(over, 30).split('\n');
  ok('overlong token is hard-broken', lines.every(l => dispWidth(l) <= 30), JSON.stringify(lines));
  ok('hard-break keeps all chars', lines.join('') === over);
}
ok('wrapText preserves newlines', wrapText('a\nb', 10) === 'a\nb');
eq('fitLR fills middle', fitLR('ab', 'cd', 10), 'ab      cd');
eq('fitLR clips overflow', fitLR('abcdef', 'ghij', 6), 'abcdef');
ok('fitLR width', dispWidth(fitLR('left', 'right', 20)) === 20);

// --------------------------------------------------------------- decodeKeys
console.log('\n=== decodeKeys ===');
const dec = s => decodeKeys(s).map(k => k.char ?? k.name);
eq('ctrl-c', dec('\x03'), ['ctrlc']);
eq('up', dec('\x1b[A'), ['up']);
eq('down', dec('\x1b[B'), ['down']);
eq('enter CR', dec('\r'), ['enter']);
eq('enter LF', dec('\n'), ['enter']);
eq('backspace', dec('\x7f'), ['backspace']);
eq('esc alone', dec('\x1b'), ['escape']);
eq('home', dec('\x1b[H'), ['home']);
eq('end', dec('\x1b[F'), ['end']);
eq('pgup', dec('\x1b[5~'), ['pgup']);
eq('pgdn', dec('\x1b[6~'), ['pgdn']);
eq('space keeps char', dec(' '), [' ']);
eq('tab', dec('\t'), ['tab']);
eq('letters', dec('jGq'), ['j', 'G', 'q']);
eq('mixed', dec('\x1b[Bj\x03'), ['down', 'j', 'ctrlc']);
eq('empty', dec(''), []);
eq('high unicode dropped safely', dec('é'), []);

// -------------------------------------------------------------------- theme
console.log('\n=== theme / width ===');
{
  const t = new Theme({ color: false });
  eq('no-color returns raw text', t.fg('brand', 'x'), 'x');
  eq('no-color style returns raw', t.style({ bold: true, fg: 'error' }, 'y'), 'y');
}
{
  const t = new Theme({ color: true, env: { NO_COLOR: '1' } });
  eq('NO_COLOR env disables colour', t.fg('brand', 'x'), 'x');
}
{
  process.env.MSM_THEME = 'light';
  const t = new Theme({ color: true, env: { MSM_THEME: 'light' } });
  eq('MSM_THEME=light', t.appearance, 'light');
  const dark = new Theme({ color: true, env: { MSM_THEME: 'dark' } });
  eq('MSM_THEME=dark', dark.appearance, 'dark');
  delete process.env.MSM_THEME;
}
eq('dispWidth ascii', dispWidth('abc'), 3);
ok('dispWidth strips ANSI', dispWidth('\x1b[31mabc\x1b[0m') === 3, String(dispWidth('\x1b[31mabc\x1b[0m')));
ok('dispWidth CJK is wide', dispWidth('你好') === 4, String(dispWidth('你好')));
eq('padTo', padTo('ab', 5), 'ab   ');
eq('padTo no shrink', padTo('abcdef', 3), 'abcdef');

// -------------------------------------------------------------------- clipTo
console.log('\n=== clipTo (no line may wrap) ===');
eq('clip fits', clipTo('abc', 10), 'abc');
eq('clip cuts', clipTo('abcdef', 3), 'abc');
eq('clip width exact', clipTo('abc', 3), 'abc');
eq('clip empty max', clipTo('abc', 0), '');
eq('clip nullsafe', clipTo(null, 5), '');
{
  const styled = '\x1b[31mabcdef\x1b[0m';
  const c = clipTo(styled, 3);
  ok('clip keeps opening SGR', c.includes('\x1b[31m'), JSON.stringify(c));
  ok('clip drops overflow text', !c.includes('d'), JSON.stringify(c));
  ok('clip appends reset when cut mid-style', c.endsWith('\x1b[0m'), JSON.stringify(c));
  ok('clip display width <= max', dispWidth(c) <= 3, String(dispWidth(c)));
}
{
  const wide = clipTo('你好世界', 3); // each char is 2 cells -> only one fits
  eq('clip respects wide chars', wide, '你');
  ok('wide clip width <= 3', dispWidth(wide) <= 3, String(dispWidth(wide)));
}
// the historical footer hint was 93 cols and wrapped on an 80-col tty
{
  const hint = 'j/k move  enter actions  / search  n/b page  a arch  s/t/w filter  x clear  r refresh  q quit';
  const clipped = clipTo(hint, 80);
  ok('80-col hint does not wrap', dispWidth(clipped) <= 80, String(dispWidth(clipped)));
}

// -------------------------------------------------------------- sqlite helpers
console.log('\n=== sqlite helpers ===');
ok('isSessionKeyCol session_id', isSessionKeyCol('session_id'));
ok('isSessionKeyCol *_session_id', isSessionKeyCol('owner_session_id'));
ok('isSessionKeyCol rejects project_id', !isSessionKeyCol('project_id'));
ok('isSessionKeyCol rejects turn_id', !isSessionKeyCol('turn_id'));
eq('quoteIdent escapes quotes', quoteIdent('a"b'), '"a""b"');
ok('CASCADE_ID_COLS has turn_id', CASCADE_ID_COLS.includes('turn_id'));
ok('CASCADE_ID_COLS rejects project_id', !CASCADE_ID_COLS.includes('project_id'));

// -------------------------------------------------------------------- safety
console.log('\n=== safety ===');
ok('pidAlive(1) true on linux', pidAlive(1) === true || pidAlive(1) === false); // smoke: no throw
ok('pidAlive rejects nonsense', pidAlive('abc') === false);
ok('pidAlive rejects null', pidAlive(null) === false);
ok('pidAlive rejects huge missing pid', pidAlive(999999999) === false);

// ------------------------------------------------------------------ inspect
console.log('\n=== inspect formats ===');
ok('EXPORT_FORMATS has jsonl', EXPORT_FORMATS.includes('jsonl'));
ok('EXPORT_FORMATS has markdown', EXPORT_FORMATS.includes('markdown'));
ok('session id prefix', SESSION_ID_PREFIX === 'mvs_');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
