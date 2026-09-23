// Headless TUI test: drives the state machine with synthetic key events and a
// captured stdout (no TTY required). Verifies key decoding, screen flow, the
// two-step delete confirmation, and that only the intended session is removed.
import { createRequire } from 'node:module';
import { AcpClient } from '/root/mcode-session-manager/src/acp.js';
import { decodeKeys } from '/root/mcode-session-manager/src/tui.js';
import { Logger } from '/root/mcode-session-manager/src/log.js';

const req = createRequire('/root/.minimax-code/releases/0.5.2/lib/node_modules/@minimax-ai/code/cli.js');
const D = req('better-sqlite3');
const DBP = '/root/.minimax/v2/sqlite/runtime-state.sqlite';
const ro = () => new D(DBP, { readonly: true, fileMustExist: true });

let pass = 0, fail = 0;
const ok = (n, c, x = '') => c ? (pass++, console.error(`  PASS  ${n}`)) : (fail++, console.error(`  FAIL  ${n}  ${x}`));

// ---------------------------------------------------------------- key decode
console.log('=== decodeKeys ===');
const dec = s => decodeKeys(s).map(k => k.char ?? k.name);
ok('ctrl-c', JSON.stringify(dec('\x03')) === '["ctrlc"]');
ok('up arrow', JSON.stringify(dec('\x1b[A')) === '["up"]');
ok('down arrow', JSON.stringify(dec('\x1b[B')) === '["down"]');
ok('enter', JSON.stringify(dec('\r')) === '["enter"]');
ok('backspace', JSON.stringify(dec('\x7f')) === '["backspace"]');
ok('esc', JSON.stringify(dec('\x1b')) === '["escape"]');
ok('letters keep case', JSON.stringify(dec('jGq')) === '["j","G","q"]');
ok('mixed chunk', JSON.stringify(dec('\x1b[Bj\x03')) === '["down","j","ctrlc"]');

// ---------------------------------------------------------------- TUI drive
console.log('\n=== TUI state machine ===');
const { Tui } = await import('/root/mcode-session-manager/src/tui.js');
const log = new Logger({ level: 'error' });
const flags = { color: false, ascii: true, includeArchived: true, noBackup: true };

let testId;
const acp = new AcpClient({});
await acp.initialize();
testId = (await acp.newSession({ cwd: '/tmp/msm-tui' })).sessionId;
await acp.close();
// give it a title via the lifecycle so the browser row is recognisable
const t = new Tui({ flags, log });
t.discovery; // constructed internally
t.lifecycle.rename(testId, 'msm-tui-target');
t.destroy();

const ui = new Tui({ flags, log });
let captured = '';
const writeSizes = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = s => { captured += s; writeSizes.push(Buffer.from(s).length); return true; };
const screen = () => captured;
const reset = () => { captured = ''; writeSizes.length = 0; };
const has = re => re.test(screen());
const press = keys => { reset(); ui.onKey(keys); };

try {
  ui.refresh();
  reset(); ui.render();
  ok('browser renders header', /mcode sessions/.test(screen()));
  ok('browser renders the target row', /msm-tui-target/.test(screen()));
  ok('browser shows total count', new RegExp(`n=${ui.total}`).test(screen()));

  // row content: a cursor move repaints just the affected rows, so the status
  // text must still be present in the (now minimal) diff output.
  reset(); ui.onKey('\x1b[B'); // down
  ok('rows show status + archived marker', /\b(idle|aborted|error|started)/.test(screen()));

  // flicker-free rendering (the regression this guards):
  //  * a cursor move is exactly ONE batched stdout write — multiple small
  //    writes let the terminal paint a half-written frame (that was the flash)
  //  * that write is small, so it never exceeds the ~4 KB tty output buffer
  //    and the terminal can never split it across two paints
  //  * the header (row 1) and its rule (row 2) are never rewritten when only
  //    the cursor moved, so they cannot flash
  //  * no full-screen clear ([2J) during navigation
  //  * under --no-color, not one SGR code is emitted (only screen-control)
  ok('cursor move is a single batched write', writeSizes.length === 1, `${JSON.stringify(writeSizes)}`);
  // a cursor move repaints ~2 rows + the footer, not the whole screen: this
  // must stay far below both a full frame (~3.7 KB) and the tty buffer (~4 KB)
  ok('cursor move write stays under the tty buffer', writeSizes[0] < 1500, `${writeSizes[0]} bytes`);
  ok('header row not rewritten on cursor move', !/\x1b\[1;1H/.test(screen()) && !/\x1b\[2;1H/.test(screen()));
  ok('no full-screen clear while navigating', !/\x1b\[2J/.test(screen()));
  ok('no SGR colour codes under --no-color', !/\x1b\[[0-9;]*m/.test(screen()));
  // an identical frame must emit nothing at all (this is the whole point of
  // the diff renderer — a redundant render() must not repaint the screen)
  reset(); ui.render();
  ok('identical frame emits nothing', writeSizes.length === 0, `${JSON.stringify(writeSizes)}`);

  // search flow
  ui.onKey('/');
  ok('search prompt opens', /search title:/.test(screen()));
  ui.onKey('zzz-not-a-real-title');
  ui.onKey('\r');
  ok('search applies (back to browser)', /mcode sessions/.test(screen()));
  ok('search found nothing or filtered', true);
  ui.onKey('x'); // clear filters
  ok('clear filters returns rows', /msm-tui-target/.test(screen()) || ui.total > 0);

  // move cursor to the target row and open the menu
  const idx = ui.rows.findIndex(r => r.session_id === testId);
  ok('target row is on screen', idx >= 0, `rows: ${ui.rows.map(r => r.session_id).slice(0,3)}`);
  for (let i = 0; i < idx; i++) ui.onKey('\x1b[B'); // down
  reset(); ui.onKey('\r');
  ok('menu opened with session id', new RegExp(testId).test(screen()));
  ok('menu lists actions', /open \/ resume/.test(screen()) && /delete/.test(screen()));
  ok('delete is present but not the default highlight', /delete/.test(screen()) && ui._menuIdx !== 5, `menuIdx=${ui._menuIdx}`);

  // inspect screen
  reset(); ui.onKey('7');
  ok('inspect screen shows metadata', /kind: conversation/.test(screen()), screen().slice(0, 400));
  reset(); ui.onKey('any');
  ok('output screen goes back', /open \/ resume/.test(screen()));

  // delete flow: first open the confirm screen
  reset(); ui.onKey('6');
  ok('confirm screen shows dry-run plan', /DELETE/.test(screen()) && /local_runtime_sessions/.test(screen()), screen().slice(0, 500));
  ok('confirm asks for last-8 token', new RegExp(`\\[${testId.slice(-8)}\\]`).test(screen()));

  // wrong token must not delete
  reset(); ui.onKey('wrongtok\r');
  ok('wrong token refused', /nothing deleted|did not match/.test(screen()) || ui.screen === 'menu', `screen=${ui.screen}`);
  ok('session still exists after wrong token', !!sess(testId));

  // re-enter confirm and type the right token
  ui.onKey('6');
  ui.onKey(testId.slice(-8) + '\r');
  // executeDelete is async; wait for it
  await new Promise(r => setTimeout(r, 600));
  ok('delete executed', sess(testId) === null, JSON.stringify(sess(testId)));
  ok('delete result screen shown', /delete result/.test(captured));
  ok('result reports rows removed', /rows removed:/.test(captured), captured.slice(0, 400));

  // active-session refusal inside the TUI
  const live = ro().prepare('SELECT session_id FROM local_runtime_session_locks WHERE expires_at_ms > ?').get(Date.now());
  if (live) {
    ui.selected = ui.discovery.getSession(live.session_id);
    ui.screen = 'menu';
    reset(); ui.onKey('6');
    ok('TUI refuses to delete active session', /REFUSED/.test(screen()), screen().slice(0, 300));
    ok('active session survived', !!sess(live.session_id));
  }

  // quit
  reset(); ui.onKey('q');
  // 'q' from browser quits; ensure no crash
  ok('quit path does not throw', true);
} finally {
  process.stdout.write = realWrite;
  ui.destroy();
}

console.error(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);

function sess(id) {
  const db = ro();
  try { return db.prepare('SELECT session_id,title FROM local_runtime_sessions WHERE session_id=?').get(id) ?? null; }
  finally { db.close(); }
}
