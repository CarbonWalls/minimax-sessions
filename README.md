# mcode-session-manager

A standalone, dependency-free terminal tool for inspecting and managing
**MiniMax Code** sessions. It is a *session manager*, not another chat
interface: browse, search, filter, inspect, rename, archive, fork, export, and
delete the sessions stored in the MiniMax runtime database.

Built and verified against **MiniMax Code 0.5.5** on linux/arm64
(termux/proot). mcode 0.5.5 persists every session as a dated directory tree
under `~/.minimax/v2/sessions/` with an authoritative `messages.jsonl`; this
tool inspects and exports that file at full fidelity (the earlier 0.5.2/0.5.3
SQLite-based management features are unchanged and still work when the runtime
database is present). The reverse-engineering behind every operation is
documented in **[RESEARCH.md](./RESEARCH.md)** — read that first if you want to
know *why* each operation is implemented the way it is.

## Requirements

- `node` (>= 20; tested on v26)
- the MiniMax Code installation under `/root/.minimax-code` — either the
  npm-global package at `lib/node_modules/@minimax-ai/code` (`mcode update` /
  `npm i -g`) or a release tree at `releases/<newest>/…`; whichever package.json
  reports the higher version is used (pin with `MSM_MCODE_RELEASE` / override
  root with `MSM_MCODE_ROOT`). Only used to load its already-installed
  `better-sqlite3` binding and to run `mcode acp` — nothing in the install is
  ever modified
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

## Deep session inspector (`store`)

mcode 0.5.5 keeps the authoritative record stream on disk. `store` browses that
tree and inspects/exports a session far beyond what a normal `/export` gives
you, while treating the raw `messages.jsonl` as the single source of truth:

```bash
mcode-sessions store                     # TUI over the on-disk session store
mcode-sessions store list [text]         # list sessions + derived metadata
mcode-sessions store search <text>       # search names / ids / cwds / models
mcode-sessions store inspect <ref>       # deep metadata + record counts
mcode-sessions store verify <ref>        # integrity + tool pairing report
mcode-sessions store export <ref>        # high-fidelity export (see below)
mcode-sessions store show <ref>          # chronological event stream
                                         #   --record N  one record
                                         #   --raw       verbatim JSONL line
                                         #   --tools     tool activity only
```

`<ref>` is any of an `mvs_` id, a session directory name, a session directory
path, or a `messages.jsonl` path.

Every session shows a derived **name** whose source is always displayed:
`stored title` (the runtime's own column) → `stored compaction summary` →
`first user message` (with injected `<system-reminder>` context stripped) →
`derived (cwd + timestamp)`. A derived name is **never** written back into the
session.

### Export formats

All exports land inside this tool's own checkout (`<checkout>/exports/`, or
`$MSM_EXPORT_DIR`) — never in `~/.minimax`.

| format | contents |
|---|---|
| `raw` | `raw_messages.jsonl` — byte-for-byte copy, sha256-verified against the source |
| `json` | `detailed.json` — every record verbatim, unknown fields included |
| `markdown` | `detailed.md` — readable chronological dump, one section per record |
| `archive` | `<name>.tar.gz` — the complete ORIGINAL session directory, untouched |
| `bundle` | a directory with raw + detailed json + markdown + `session_info.json` + `integrity.txt` + the original metadata sidecars + `MANIFEST.sha256` |
| `info` | `session_info.json` alone, with `stored` vs `derived` clearly separated |
| `integrity` | `integrity.txt` alone |

`--redact` produces a clearly-labelled, best-effort redacted variant (API keys,
bearer tokens, secret-looking values, private keys). It is **not** guaranteed
complete — review it before sharing. The source session is never modified.

### Integrity checking

`store verify` reports totals, roles, content block types, tool calls/results,
matched pairs, missing results, orphan results, duplicate ids, malformed
records, an incomplete trailing record (a session being written right now),
and every unknown role / block type / top-level / message / tool field — so a
future mcode schema change surfaces as a new "unknown" entry instead of being
silently consumed. The parser never normalises a record: each one keeps its
exact source text and its parsed object, so raw exports are lossless and
structured exports carry fields this tool does not yet understand.

### Live sessions

Sessions may be actively written by mcode. The parser streams the file, keeps a
record that is not newline-terminated as a *malformed-but-preserved* entry, and
reports `SESSION MAY CURRENTLY BE IN USE — trailing record is incomplete`
rather than crashing or discarding it. Exports snapshot the source's size and
sha256 before and after, and warn if the session moved during the export. The
source is only ever opened for reading and is never locked.

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
*delete*). In the file-store TUI the same menu adds:

```
i  deep inspect (records)   metadata panel + chronological event stream
e  export…                  pick a format; written into <checkout>/exports
```

The deep inspector's event stream renders the ORIGINAL stored order and
distinguishes `USER` / `ASSISTANT` / `THINKING` / `TOOL CALL` / `TOOL RESULT`.
From it: `enter` opens one record as pretty-printed JSON, `r` shows the
verbatim source line, `t` toggles a tool-only view, `v` the integrity report,
`/` + `n`/`N` search inside the session with match counts, and jumping between
a tool call and its result is one key. Nothing is flattened away.

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
mcode-sessions store                 # TUI over the on-disk session store
mcode-sessions store list [text]     # list file-store sessions
mcode-sessions store search <text>   # search names / ids / cwds / models
mcode-sessions store inspect <ref>   # deep metadata + record counts
mcode-sessions store verify <ref>    # integrity / pairing report
mcode-sessions store export <ref>    # --format raw|json|markdown|archive|
                                      #          bundle|info|integrity
mcode-sessions store show <ref>      # --record N --raw --tools
mcode-sessions list [text]           # list sessions (runtime database)
mcode-sessions search <text>         # search title/purpose/id (--messages also hits bodies)
mcode-sessions inspect <id>          # compact metadata
mcode-sessions rename <id> <title>   # rename
mcode-sessions archive <id>          # archive
mcode-sessions unarchive <id>        # unarchive
mcode-sessions fork <id>             # fork via the native runtime
mcode-sessions delete <id>           # --dry-run by default; --confirm to run
mcode-sessions export <id>           # --format markdown|json|jsonl|metadata
mcode-sessions stats <id>            # usage / statistics
mcode-sessions active <id>           # is it running?
mcode-sessions plan <id>             # dry-run deletion plan
mcode-sessions resume <id>           # launch mcode attached to a session (--dry-run to preview)
mcode-sessions doctor                # environment / schema / native-runtime health check
```

The `store` commands work with **no database at all** — they read the session
tree directly — so they keep working after the runtime has dropped old
sessions from its index. When the SQLite database *is* present, its title /
status / kind / workspace / parent columns enrich the same rows.

```
filters: --archived/--no-archived/--only-archived  --status <s>  --kind <k>
         --workspace <dir>  --parent <id>
safety:  --dry-run  --confirm  --no-backup  --session <id>
output:  --json  --limit <n>  --offset <n>  --out <file|dir>  --format <fmt>
         --record <n>  --max-records <n>  --redact  --tools  --raw
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
mcode-sessions store export mvs_13d9801f4c4c43a084f8908f8956c612 --format bundle
mcode-sessions store verify mvs_13d9801f4c4c43a084f8908f8956c612
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
src/store.js              0.5.5 file-store index (dated session tree, lazy per-session loads)
src/jsonl.js              streaming messages.jsonl parser: records, pairing, integrity, names
src/exportx.js            raw / json / markdown / archive / bundle / info / integrity exports
src/theme.js              mcode `minimax` theme palette + colour degradation
src/tui.js                keyboard-only terminal UI
src/cli.js                CLI command surface (incl. doctor, resume, store)
tests/unit.test.mjs       fast pure-function tests (no DB required)
tests/jsonl.test.mjs      parser + store + exporter tests on synthetic fixtures
tests/tui.test.mjs        headless TUI state-machine checks
tests/mutations.test.mjs  mutation checks against disposable sessions
tools/scratch-ctx.mjs     RESEARCH helper (bounded context around a regex)
RESEARCH.md               reverse-engineering report for every operation
```

## Theming

The TUI reuses **mcode's own `minimax` theme** rather than inventing colours.
The palette was lifted verbatim out of the installed mcode bundle
(`chunks/launcher-*.js`, the `minimax` dark/light colour maps — identical in
0.5.2 and 0.5.3; only the chunk hash renamed), so the session manager matches
the agent it manages:

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
npm test                # unit + jsonl + tui + mutations
npm run test:unit       # fast pure-function checks (no DB / no mcode needed)
npm run test:jsonl      # parser / store / exporter against synthetic fixtures
npm run test:tui        # headless TUI: keys, screens, two-step delete confirm
npm run test:mutations  # creates disposable sessions, mutates, verifies the DB
npm run doctor          # environment / schema / native ACP health check
```

The `jsonl` suite builds its whole session tree in an OS temp directory and
removes it afterwards; the real `~/.minimax/v2/sessions` is only ever read
(and only by one opt-in read-only smoke check). Raw export byte-identity,
unknown-field survival, thinking/tool-argument/tool-result preservation,
missing/orphan/duplicate pairing, malformed and incomplete-trailing records,
redaction, and source-immutability are all asserted.

All suites exit non-zero on any failure. Sessions created by the mutation/TUI
suites are removed by those suites themselves. Paths are resolved relative to
the checkout, so a clone under `projects/` runs its own tests against itself.
