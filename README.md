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
- the MiniMax Code installation at `/root/.minimax-code/releases/0.5.2/…`
  (only used to load its already-installed `better-sqlite3` binding and to run
  `mcode acp` — nothing in the install is ever modified)
- the runtime database at `/root/.minimax/v2/sqlite/runtime-state.sqlite`

Both locations can be overridden with `MSM_RUNTIME_DATA_DIR` / `MSM_HOME`.

## Install / run

```bash
# from anywhere
node /root/mcode-session-manager/bin/mcode-sessions          # interactive TUI

# or put it on PATH
ln -s /root/mcode-session-manager/bin/mcode-sessions /usr/local/bin/mcode-sessions
mcode-sessions
```

## Interactive TUI (default)

A compact, keyboard-only browser for a narrow phone terminal:

```
 mcode sessions  n=23  archived=1  locked=1
──────────────────────────────────────────────────────────────
›  1  1 - Ask about available tools…  idle  2h
   2  debugging mcode                 idle  3h
   3  (untitled)                      started  3h
   ...
──────────────────────────────────────────────────────────────
page 1/2  arch-in
j/k move  enter actions  / search  n/b page  a arch  s/t/w filter  x clear  r refresh  q quit
```

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
mcode-sessions search <text>         # search by title
mcode-sessions inspect <id>          # compact metadata
mcode-sessions rename <id> <title>   # rename
mcode-sessions archive <id>          # archive
mcode-sessions unarchive <id>        # unarchive
mcode-sessions fork <id>             # fork via the native runtime
mcode-sessions delete <id>           # --dry-run by default; --confirm to run
mcode-sessions export <id>           # --format json|markdown|metadata
mcode-sessions stats <id>            # usage / statistics
mcode-sessions active <id>           # is it running?
mcode-sessions plan <id>             # dry-run deletion plan

filters: --archived/--no-archived  --status <s>  --kind <k>  --workspace <dir>
safety: --dry-run  --confirm  --no-backup  --session <id>
output: --json  --ascii  --no-color  --debug/--verbose
```

Examples:

```bash
mcode-sessions search "x posts"
mcode-sessions delete mvs_220667ba0ba94c14aa48225ae1e72540 --dry-run
mcode-sessions delete mvs_220667ba0ba94c14aa48225ae1e72540 --confirm
mcode-sessions export mvs_e16989c9a5da444bacbd447ac45ada5f --format json > s.json
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
  (unless `--no-backup`), and its path is printed
- deletes run in one transaction; a row-count mismatch aborts and rolls back
- after deleting, the tool verifies the session row and representative
  dependents are gone, and reports leftovers if any
- logs go to `~/.mcode-session-manager/logs/msm.log`, never into the MiniMax DB

## Layout

```
bin/mcode-sessions        entrypoint
src/env.js                paths + flag parsing (no global env mutation)
src/log.js                logger -> ~/.mcode-session-manager/logs/
src/sqlite.js             sqlite adapter (reuses mcode's better-sqlite3) + schema introspection
src/acp.js                native ACP JSON-RPC client (stdio) — the real runtime interface
src/discovery.js          session discovery: list/filter/count/messages/usage
src/safety.js             active detection, dry-run plan builder, backup
src/lifecycle.js          rename / archive / fork / delete (native-first)
src/inspect.js            inspect / stats / export
src/tui.js                keyboard-only terminal UI
src/cli.js                CLI command surface
tests/mutations.test.mjs  48 mutation checks against disposable sessions
tests/tui.test.mjs        32 TUI state-machine checks
RESEARCH.md               reverse-engineering report for every operation
```

## Tests

```bash
node tests/mutations.test.mjs    # creates disposable sessions, mutates, verifies the DB
node tests/tui.test.mjs          # headless TUI: keys, screens, two-step delete confirm
```

Both exit non-zero on any failure. Sessions created for the tests are removed by
the tests themselves.
