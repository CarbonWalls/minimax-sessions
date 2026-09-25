// Pure scrolling test (NO database): stubs Discovery.list with a synthetic
// dataset and drives the Tui's browser state machine directly. Verifies the
// infinite-scroll contract:
//   * rows ACCUMULATE and previously loaded items are never cleared;
//   * loading appends at the tail, producing no duplicates;
//   * the viewport (offset) advances one row at a time (no page jumps);
//   * the cursor rides the CENTRE of the page, so rows below it stay visible and
//     the end of the list is in view before it is reached (clamped at both ends);
//   * cursor position (global) and wrapping behave correctly.
import { Tui } from '../src/tui.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${x}`));

const N = 500; // synthetic filtered dataset size
const rowsFor = (from, len) => Array.from({ length: len }, (_, i) => {
  const k = from + i;
  return {
    session_id: `mvs_synthetic_${String(k).padStart(3, '0')}`,
    title: `session ${k}`, status: 'idle', archived: 0,
    updated_at_ms: N - k,
  };
});
const fakeList = ({ limit, offset }) => {
  const from = Math.min(offset, N);
  const len = Math.min(limit, N - from);
  return { rows: rowsFor(from, len), total: N };
};

const flags = { color: false, ascii: true, includeArchived: true, noBackup: true };
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true; // render() writes harmlessly

const ui = new Tui({ flags, log: { debug() {}, info() {}, verbose() {} } });
ui.discovery.list = fakeList;
ui.discovery.facetCounts = () => ({ archived: 0, active: 0 });
ui.refresh();

const ps = ui.pageSize;
ok('refresh seeds the first batch (>= one page)', ui.rows.length >= ps, `rows=${ui.rows.length} ps=${ps}`);
ok('seed batch >= 100 (infinite-scroll batch)', ui.rows.length >= 100, `rows=${ui.rows.length}`);
ok('total is the full dataset size', ui.total === N, `total=${ui.total}`);
ok('position starts at 1/N', ui.positionInfo().cur === 1 && ui.positionInfo().total === N);

// Scroll down far enough to force several append batches; items are preserved.
const firstId = ui.rows[0].session_id;
const firstLen = ui.rows.length;
for (let i = 0; i < 200; i++) ui.moveDown();
ok('rows accumulated beyond the seed batch', ui.rows.length > firstLen, `${firstLen} -> ${ui.rows.length}`);
ok('first loaded item is preserved (never cleared)', ui.rows[0].session_id === firstId, ui.rows[0]?.session_id);
ok('no duplicate session ids while accumulating',
   new Set(ui.rows.map(r => r.session_id)).size === ui.rows.length, `len=${ui.rows.length}`);
ok('cursor tracks a global index', ui.cursor === 200, `cursor=${ui.cursor}`);
ok('position info matches cursor', ui.positionInfo().cur === 201, `cur=${ui.positionInfo().cur}`);

// Viewport slides ONE row at a time — record offset deltas across moves.
const offsets = [];
let prev = ui.offset;
for (let i = 0; i < 60; i++) { ui.moveDown(); offsets.push(ui.offset - prev); prev = ui.offset; }
ok('offset advances monotonically (no upward jump on scroll-down)',
   offsets.every(d => d >= 0), JSON.stringify(offsets));
ok('offset never jumps more than one row per move', offsets.every(d => d <= 1), JSON.stringify(offsets));

// Centre-anchored: the cursor rides the MIDDLE of the page once it starts
// scrolling, so rows below the cursor stay visible and the end of the list is in
// sight a half-page before you reach it.
const mid = Math.floor(ps / 2);
ok('cursor rides the viewport centre', ui.offset + mid === ui.cursor, `offset=${ui.offset} cursor=${ui.cursor} mid=${mid}`);

// Symmetric going up: the cursor stays centred and the viewport retreats one row
// at a time.
const upDeltas = [];
let upPrev = ui.offset;
for (let i = 0; i < 40; i++) { ui.moveUp(); upDeltas.push(ui.offset - upPrev); upPrev = ui.offset; }
ok('cursor stays centred while scrolling up', ui.offset + mid === ui.cursor, `offset=${ui.offset} cursor=${ui.cursor} mid=${mid}`);
ok('offset retreats by at most one row per move up', upDeltas.every(d => d >= -1 && d <= 0), JSON.stringify(upDeltas));

// Above the centre line the page stays put; it only slides once the cursor
// crosses it (so the top of the list stays fully in view while the cursor roams
// the upper half).
ui.goTop();
for (let i = 0; i < mid; i++) ui.moveDown();
ok('page does not scroll above the centre line', ui.offset === 0 && ui.cursor === mid, `offset=${ui.offset} cursor=${ui.cursor}`);
ui.moveDown();
ok('viewport slides after the cursor crosses the centre', ui.offset === 1, `offset=${ui.offset}`);

// Near the end the viewport clamps: the last row stays pinned to the bottom of
// the page, so the end is visible before the cursor lands on it.
ui.goTop();
for (let i = 0; i < N - 4; i++) ui.moveDown();
ok('viewport clamps near the end (last row visible)', ui.offset + ps - 1 === N - 1, `offset=${ui.offset} ps=${ps} N=${N}`);
ok('cursor is still short of the last row', ui.cursor === N - 4, `cursor=${ui.cursor}`);

// goBottom loads everything and keeps all items.
ui.goBottom();
ok('goBottom loads the full dataset', ui.rows.length === N, `rows=${ui.rows.length}`);
ok('goBottom unique count intact', new Set(ui.rows.map(r => r.session_id)).size === N);
ok('goBottom positions at the last row', ui.cursor === N - 1 && ui.offset === N - ps, `cursor=${ui.cursor} offset=${ui.offset}`);

// moveDown past the end wraps to the top.
ui.moveDown();
ok('wraps to top at the end', ui.cursor === 0 && ui.offset === 0, `cursor=${ui.cursor} offset=${ui.offset}`);

// moveUp from the top wraps to the bottom.
ui.goTop();
ui.moveUp();
ok('wraps to bottom above the top', ui.cursor === N - 1, `cursor=${ui.cursor}`);

process.stdout.write = realWrite;
ui.destroy();

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
