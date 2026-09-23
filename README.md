# mcode-session-manager

A standalone, dependency-free terminal tool for inspecting and managing
**MiniMax Code** sessions. It is a *session manager*, not another chat
interface: browse, search, filter, inspect, rename, archive, fork, export, and
delete the sessions stored in the MiniMax runtime database.

Built and verified against **MiniMax Code 0.5.2** on linux/arm64
(termux/proot). The reverse-engineering behind every operation is documented in
**[RESEARCH.md](./RESEARCH.md)** — read that first if you want to know *why*
each operation is implemented the way it is.

## Requirements

- `node` (>= 20; tested on v26)
- the MiniMax Code installation at `/root/.minimax-code/releases/<newest>/…`
  (auto-discovered; pin with `MSM_MCODE_RELEASE` / override root with
  `MSM_MCODE_ROOT`. Only used to load its already-installed `better-sqlite3`
  binding and to run `mcode acp` — nothing in the install is ever modified)
- the runtime database at `/root/.minimax/v2/sqlite/runtime-state.sqlite`

Both locations can be overridden with `MSM_RUNTIME_DATA_DIR` / `MSM_HOME`.
Run `mcode-sessions doctor` if anything looks misconfigured.

## Install / run

```bash
# from anywhere
node /root/mcode-session-manager/bin/mcode-sessions          # interactive TUI

# or put it on PATH
ln -s /root/mcode-session-manager/bin/mcode-sessions /usr/local/bin/mcode-sessions
mcode-sessions
```

## Interactive TUI (default)

A compact, keyboard-only browser for a narrow phone terminal, themed to match
mcode itself (see [Theming](#theming) below):

```
 mcode sessions  n=23  archived=1  locked=1  ↓
──────────────────────────────────────────────────────────────
›  1  1 - Ask about available tools…  idle  2h
   2  debugging mcode                 idle  3h
   3  (untitled)                      started  3h
   ...
──────────────────────────────────────────────────────────────
 1/23  arch-in
j/k move  enter actions  / search  n/b page  a arch  s/t/w filter  x clear  r refresh  q quit
```

- renders into the alternate screen buffer and repaints in place, so the header
  never stacks up as you move around, and it refits live on terminal resize
- **windowed scrolling**: only one screen-full of rows is fetched at a time;
  the next/previous window loads as the cursor reaches the edge
- the footer always shows `x/y` — the cursor's position over the total — and
  pushing past either end wraps to the other side (so you never get lost)
- **live search**: `/` opens a prompt that filters the list on every keystroke;
  `enter` applies, `esc` cancels
- degrades gracefully: below ~46 columns it shows only `number + title + status`
- `--ascii` replaces box-drawing characters with plain ASCII
- handles terminal resize and Ctrl-C cleanly; no mouse required

Selecting a session opens an action menu (default highlight is *inspect*, never
*delete*):

```
 session: debugging mcode
 id: mvs_…
 status: idle   kind: conversation   ws: /root
──────────────────────────────────────────────────────────────
  1  open / resume
  2  rename
  3  archive
  4  unarchive
  5  fork / clone
  6  delete
  7  inspect
  8  export
  9  usage / stats
  0  back
```

`esc` / `q` / backspace go back. Delete shows a dry-run plan and then requires
typing the last 8 characters of the session id before anything is removed.

## CLI

```
mcode-sessions                       # interactive TUI (default)
mcode-sessions list [text]           # list sessions
mcode-sessions search <text>         # search title/purpose/id (--messages also hits bodies)
mcode-sessions inspect <id>          # compact metadata
mcode-sessions rename <id> <title>   # rename
mcode-sessions archive <id>          # archive
mcode-sessions unarchive <id>        # unarchive
mcode-sessions fork <id>             # fork via the native runtime
mcode-sessions delete <id>           # --dry-run by default; --confirm to run
mcode-sessions export <id>           # --format markdown|json|jsonl|metadata  [--out FILE]
mcode-sessions stats <id>            # usage / statistics
mcode-sessions active <id>           # is it running?
mcode-sessions plan <id>             # dry-run deletion plan
mcode-sessions resume <id>           # launch mcode attached to a session (--dry-run to preview)
mcode-sessions doctor                # environment / schema / native-runtime health check

filters: --archived/--no-archived/--only-archived  --status <s>  --kind <k>
         --workspace <dir>  --parent <id>
safety:  --dry-run  --confirm  --no-backup  --session <id>
output:  --json  --limit <n>  --offset <n>  --out <file>  --format <fmt>
         --ascii  --no-color  --debug/--verbose
```

Both `--flag value` and `--flag=value` forms are accepted. Unknown flags are
collected and warned about (in the log) instead of being silently swallowed.

Examples:

```bash
mcode-sessions search "x posts"
mcode-sessions list --limit 20 --no-archived
mcode-sessions delete mvs_220667ba0ba94c14aa48225ae1e72540 --dry-run
mcode-sessions delete mvs_220667ba0ba94c14aa48225ae1e72540 --confirm
mcode-sessions export mvs_e16989c9a5da444bacbd447ac45ada5f --format jsonl --out s.jsonl
mcode-sessions doctor
```

## How each operation works (short version)

| Operation | Mechanism |
|---|---|
| list / browse | read-only SQLite on `local_runtime_sessions` (rich columns the ACP list can't return); ids cross-checkable against the native ACP `session/list` |
| fork | **native**: `mcode acp` → ACP `session/fork` (real runtime fork; copies messages). The tool refuses to fake a fork by copying rows |
| rename / archive / unarchive | transactional SQLite mirroring the runtime's columnar semantics, with `record_json` kept consistent |
| delete | refused if the session is active; dry-run plan built from the **live schema**; explicit confirmation; automatic backup; single transaction; verification afterwards |
| inspect / stats / export | read-only SQLite (`local_runtime_message_rows`, `local_runtime_token_usage`, …) |

`mcode acp` exposes `list/fork/new/load/resume/close` but **not** delete/archive/
rename (`session/delete` → `Method not found`; the Desktop HTTP API that has them
is not listening). Those therefore use the conservative SQLite fallback — see
[RESEARCH.md](./RESEARCH.md) for the full evidence.

## Safety properties

- destructive operations need an exact `mvs_` id — never a title, never fuzzy
- active/running sessions (live row in `local_runtime_session_locks`,
  `status='started'`, or a live owning pid) are refused automatically
- the deletion plan is computed by introspecting the schema at runtime and only
  ever targets `WHERE <session key> = <exact id>`
- a database backup is written before the first real destructive operation
  (unless `--no-backup`), and its path is printed; old backups are pruned to
  the newest `MSM_BACKUP_KEEP` (default 5)
- deletes run in one transaction; a row-count mismatch aborts and rolls back
- after deleting, every planned table is re-counted; cascade children are
  verified by the concrete ids captured *before* the parent row disappeared
  (so a dead subquery cannot mask leftovers), and any remainder is reported
- logs go to `~/.mcode-session-manager/logs/msm.log` (rotated at 1 MiB, keep 3),
  never into the MiniMax DB

## Layout

```
bin/mcode-sessions        entrypoint
src/env.js                paths + flag parsing (auto-discovers newest mcode release)
src/log.js                logger -> ~/.mcode-session-manager/logs/ (size-capped)
src/format.js             shared age/id/title formatting for CLI + TUI
src/sqlite.js             sqlite adapter (reuses mcode's better-sqlite3) + schema introspection
src/acp.js                native ACP JSON-RPC client (stdio) — the real runtime interface
src/discovery.js          session discovery: list/filter/count/messages/usage
src/safety.js             active detection, dry-run plan builder, backup + retention
src/lifecycle.js          rename / archive / fork / delete (native-first)
src/inspect.js            inspect / stats / export (markdown|json|jsonl|metadata)
src/theme.js              mcode `minimax` theme palette + colour degradation
src/tui.js                keyboard-only terminal UI
src/cli.js                CLI command surface (incl. doctor, resume)
tests/unit.test.mjs       fast pure-function tests (no DB required)
tests/tui.test.mjs        headless TUI state-machine checks
tests/mutations.test.mjs  mutation checks against disposable sessions
tools/scratch-ctx.mjs     RESEARCH helper (bounded context around a regex)
RESEARCH.md               reverse-engineering report for every operation
```

## Theming

The TUI reuses **mcode's own `minimax` theme** rather than inventing colours.
The palette was lifted verbatim out of the installed 0.5.2 bundle
(`chunks/launcher-BKHZAKO7.js`, the `qi("minimax", …)` colour maps), so the
session manager matches the agent it manages:

| Role in this tool        | mcode role     | Colour (dark)  |
|---|---|---|
| header / brand           | `brand`        | `#68C0FF`      |
| selected row, position   | `signal`       | `#68C0FF`      |
| `started` sessions       | `signal`       | `#68C0FF`      |
| `archived` marker        | `warning`      | `#FFC340`      |
| `aborted` sessions       | `warning`      | `#FFC340`      |
| delete / destructive     | `error`        | `#FF5E6C`      |
| success / verified       | `success`      | `#28C567`      |
| row text                 | `text`         | `#D6D6D6`      |
| counts, secondary        | `muted`        | `#ADADAD`      |
| hints, ages              | `dim`          | `#666666`      |
| separators               | `border`       | `#303030`      |
| selected-row background  | `userMessageBg`| `#262626`      |

Behaviour details, all matching how mcode itself behaves:

- reads the active theme name from mcode's own settings file
  (`~/.minimax/tui/tui-settings.json`, currently `minimax`), so if you switch
  mcode's theme the tool follows
- light/dark is resolved the way mcode resolves it: from `COLORFGBG` luminance,
  defaulting to dark. Override with `MSM_THEME=light` / `MSM_THEME=dark`
- colour depth follows the terminal's reported capability, down the same ladder
  mcode uses: truecolor → 256-colour (hex converted via the standard
  rgb→ansi256 function) → 16-colour (mcode's named fallback table) → none
- `--no-color` (or `NO_COLOR`) emits **no** SGR colour codes at all — only
  structural screen-control escapes
- `--ascii` swaps the box-drawing glyphs for plain ASCII independently of colour

## Tests

```bash
npm test                # unit + tui + mutations
npm run test:unit       # fast pure-function checks (no DB / no mcode needed)
npm run test:tui        # headless TUI: keys, screens, two-step delete confirm
npm run test:mutations  # creates disposable sessions, mutates, verifies the DB
npm run doctor          # environment / schema / native ACP health check
```

All suites exit non-zero on any failure. Sessions created by the mutation/TUI
suites are removed by those suites themselves. Paths are resolved relative to
the checkout, so a clone under `projects/` runs its own tests against itself.
