# MiniMax Code 0.5.2 — Session Lifecycle Reverse-Engineering Report

Findings obtained by inspecting the installed MiniMax Code 0.5.2 bundle and the
live runtime database, **read-only**, plus empirical probes against the real
`mcode acp` server.

Environment inspected:

- mcode install root: `/root/.minimax-code/releases/0.5.2/lib/node_modules/@minimax-ai/code`
- runtime database:  `/root/.minimax/v2/sqlite/runtime-state.sqlite` (WAL mode)
- node: v26.8.2 (arm64, termux/proot debian)

---

## 0. Two cooperating systems (important mental model)

1. **The TUI bundle** `@minimax-ai/code@0.5.2` — bundled/minified ES modules under
   `chunks/`. It is *both* an ACP **client** and an ACP **server**
   (`mcode acp` runs it as a server over stdio).
2. **The agent runtime data** under `/root/.minimax` — owns
   `runtime-state.sqlite`, whose `local_runtime_sessions` table holds the
   `mvs_*` sessions (this is the table the tool must manage).

The string `local_runtime_sessions` appears **nowhere** in the mcode bundle.
The bundle reaches these sessions through the runtime object it constructs at
startup. Verified empirically: spawning `mcode acp` and calling `session/list`
returns exactly the same `mvs_*` ids/titles/cwds as a direct read of
`local_runtime_sessions`. So **`mcode acp` is a real, safely-accessible
runtime/lifecycle interface for this data**, and it is the one this tool uses.

---

## 1. Native ACP interface (JSON-RPC over stdio) — the accessible runtime

Entrypoint: `mcode acp` (documented as *"Run MiniMax Code as an Agent Client
Protocol server over stdio"*). Transport is newline-delimited JSON-RPC 2.0 on
stdin/stdout. `initialize` **requires `protocolVersion: 1`** (a number; the
server returns `protocolVersion:1` and `agentInfo.version:"0.5.2"`).

Server-declared session capabilities: `{list, fork, resume, close}`.

Method map recovered from `chunks/run-acp-command-QDFMFQRS.js`:

| ACP method | params | result | status |
|---|---|---|---|
| `initialize` | `{protocolVersion:1, clientCapabilities, clientInfo}` | capabilities + agentInfo | ✅ works |
| `session/list` | `{cwd?, cursor?}` | `{sessions:[{sessionId,cwd,title,updatedAt}], nextCursor?}` | ✅ works (always `includeArchived:true`; only `cwd` filter + cursor pagination) |
| `session/new` | `{cwd, mcpServers}` | `{sessionId, modes, configOptions}` | ✅ works |
| `session/load` | `{sessionId, cwd, mcpServers}` | `{modes, configOptions}` | ✅ works — **does NOT return messages** |
| `session/fork` | `{sessionId, cwd, mcpServers?, additionalDirectories?}` | `{sessionId, modes, configOptions}` | ✅ works |
| `session/resume` | `{sessionId, cwd}` | modes/config | ✅ implemented |
| `session/close` | `{sessionId}` | `{}` | ✅ implemented |
| `session/setMode` | `{sessionId, modeId}` | `_meta` | ✅ implemented |
| `session/setConfigOption` | `{sessionId, configId, type, value}` | — | ✅ only `permissionMode` + `model` (select controls) |
| `session/prompt` | `{sessionId, prompt, ...}` | streaming | ✅ implemented |
| **`session/delete`** | — | — | ❌ **`-32601 "Method not found": session/delete`** |
| **`session/cancel`** | — | — | ❌ **`-32601 "Method not found"`** |

The server-side handlers are registered in `run-acp-command-QDFMFQRS.js`, e.g.
`J.onRequest(ee.agent.session.fork, …)` which calls
`e.runtime.getSessionForkOptions(id)` and then
`e.runtime.forkSession({sessionId, clientRequestId, useSuggestedTitle:true,
createIsolatedWorktree:false})`. There is **no** `J.onRequest(...session.delete...)`.

Empirical fork test (source `mvs_d48a7326…`, which has messages):

- created `mvs_023361fab332442b9d234fdd2a230943`, title auto-set to
  `"1 - Ask about available tools and web access"` (`useSuggestedTitle`),
  `parent_session_id` column = NULL, status `idle`, same workspace;
- `local_runtime_message_rows`: source 103 → fork **104** (messages copied, +1 boundary);
- `local_runtime_turn_diffs`: 3 → **3** (copied — so the fork **shares turn ids** with its source);
- `local_runtime_token_usage`: 91 → **0** (not copied);
- `local_runtime_turn_ingress`: 6 → **0** (not copied — so turn_ingress rows still belong to the source).

Two consequences, both handled by this tool:

1. **A fork cannot relocate a session.** The server validates the requested cwd:
   `session/fork` with `cwd != source.workspace_dir` returns
   `-32602 "Invalid params: Requested cwd does not match the persisted session
   workspace"`. So "choose a destination workspace" is *not* supported by the
   runtime; the tool forks in place and rejects a mismatched `--cwd` up front.
2. **Cascade deletion must be id-owner-scoped.** Because a fork shares turn ids
   with its source, deleting a fork via `turn_id IN (SELECT turn_id FROM
   <any table that merely has turn_id>)` would delete the *source's* rows. The
   tool therefore cascades only via a table that *owns* the id (the id column is
   part of that table's PRIMARY KEY): `local_runtime_turn_ingress` (PK=turn_id)
   and `local_runtime_background_tasks` (PK=task_id). Verified: deleting the
   fork removed 116 rows across 9 tables while the source kept all 103 message
   rows, 6 `turn_ingress` rows and 6 `turn_ingress_sequences` rows.

Fork on an empty session fails with `-32602 "Invalid params:
message-boundary-not-found"` (the runtime needs a message boundary to fork from).

---

## 2. Internal runtime lifecycle methods — found, but NOT reachable from a standalone tool

Recovered from `chunks/chunk-LED6SDUJ.js` (the 11 MB runtime chunk):

- `session.lifecycle.deleteSession(id)`, `deleteSessionById(id)`,
  `archiveSession(id, archived)`, `archiveSessionById(id)`,
  `archiveSessionWithinMaintenance(id)`, `setArchived(id, on)`,
  `updateSession(id, patch)`, `compressSession`.
- `session.conversationMutation.forkSession(...)`, `getSessionForkOptions(...)`.
- Store-level deletes (the actual SQL):
  - messages store `deleteSession(id)` deletes
    `local_runtime_messages`, `local_runtime_message_rows`,
    `local_runtime_message_row_migrations`, `local_runtime_pi_history_rows`,
    `local_runtime_pi_history_row_migrations`, `local_runtime_session_assets`,
    `local_runtime_session_asset_index_state`;
  - queue store `deleteSession(id)` deletes `local_runtime_queues`,
    `local_runtime_queue_items`, `local_runtime_queue_row_migrations`;
  - projection service `deleteSession(id)` additionally clears
  `ledger_store`/`projection_store`/`snapshot_store` state for the session;
  - orchestrations also touch permissions, questionnaires, turn-diffs, memory,
    workspace-indexing and plugin-hook cleanup.
- `DesktopService` HTTP API (hono routes in the same chunk):
  - `PATCH /minimax-desktop/api/v1/session/:id` → `updateSession` (title, memoryPolicy)
  - `POST  /minimax-desktop/api/v1/session/:id/archive` → `archiveSession`
  - `DELETE /minimax-desktop/api/v1/session/:id` → `deleteSession`

  **But no socket is listening** in this environment (`/proc/net/tcp` and
  `/proc/net/tcp6` show nothing bound), so this HTTP API is not usable from a
  standalone process. It exists for the MiniMax Desktop app.

**Conclusion:** delete / archive / unarchive / rename have **no accessible
native entrypoint** for a standalone tool in this environment. They must be
implemented as a conservative, transactional SQLite fallback that mirrors the
runtime's own columnar semantics. `list` and `fork` *do* have a native path and
the tool uses it.

---

## 3. Database facts (verified at runtime, not assumed)

`local_runtime_sessions` (27 columns). Central detail: **`record_json` is a
v2-migration placeholder and is NOT authoritative** — every row currently
contains an identical synthetic record:

```json
{"sessionId":"mvs_…","agentName":"__local_runtime_v2__","workspaceDir":"/root",
 "runtime":"pi-agent","sessionType":"branch","archived":true,"visibility":"hidden",
 "status":"idle","createdAtMs":…,"updatedAtMs":…}
```

…while the denormalized columns hold the *real* state (e.g. `archived=0`,
`visibility='visible'`, `session_kind='conversation'`, actual `title`).
`columnar_version = 3` for all rows. The only columnar write in the bundle is
the one-time v2 migration (`UPDATE … SET <all columns>, columnar_version=3`),
and the legacy store upsert only touches `record_json`/`updated_at_ms`.

There are **4 triggers** on `local_runtime_sessions`; all maintain
`local_runtime_projects` (`session_count`, `latest_activity_at_ms`) on
insert/update/delete. They do **not** sync `record_json` ↔ columns. Deleting a
session row therefore automatically recomputes project bookkeeping.

`local_runtime_session_fts_keys` declares
`FOREIGN KEY(session_id) REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE`,
but SQLite foreign-key enforcement is off by default in better-sqlite3, so
cascades **cannot be relied on** — this is why the tool deletes from every
session-keyed table explicitly.

`local_runtime_sessions_fts` is a **standalone fts5** table (no `content=`
external-content clause), so it needs explicit deletes; its shadow tables are
`..._data/_idx/_docsize/_content`.

### Message / usage storage (for inspect, export, stats)

- `local_runtime_messages` is **empty** — v2 uses `local_runtime_message_rows`
  (`id, session_id, msg_id, role, turn_id, created_at_ms, data_json, source,
  source_context_json`). `data_json` holds `{msg_id, role, msg_content,
  msg_type, timestamp, turn_id|turnId, query_key, source}`. Roles observed:
  `user`(48), `assistant`(505), `system`(1), NULL(16).
- Token usage: `local_runtime_token_usage` (`session_id, agent_name, turn_id,
  model, ts, input_tokens, output_tokens, reasoning_tokens,
  cache_read_tokens, cache_write_tokens, cost_usd, raw`).
- Background work: `local_runtime_background_tasks` / `_events` are keyed by
  **`owner_session_id`** (not `session_id`).
- Other alternate key names: `local_runtime_communication_messages`
  (`from_session`, `to_session`), `local_runtime_legacy_migrations`
  (`local_session_id`, `legacy_session_id`), `local_runtime_v2_cron_definitions`
  (`target_session_id`).
- Dependent-only tables (no session key): `local_runtime_turn_ingress_sequences`
  (keyed by `turn_id`), `local_runtime_background_task_events` (by `task_id`),
  `local_runtime_v2_memory_execution_tasks`/`_calls` (by `task_id`).

### Active-session detection (for delete safety)

- `local_runtime_session_locks(session_id PK, owner_id, owner_kind,
  acquired_at_ms, expires_at_ms)` — the authoritative runtime lock. Observed
  row: `mvs_fdc4248…` (the currently-running session), `owner_id =
  'turn-lease:28238:<lease-uuid>'`, `owner_kind='turn'`, with an absolute
  `expires_at_ms`. An **unexpired** lock ⇒ the session is active/running.
- `local_runtime_sessions.status` — observed values `idle`(15), `aborted`(6),
  `error`(1), `started`(1). `started` ⇒ running.
- `agents` table exposes `pid`, `process_alive`, `main_session_id`.
- `/root/.minimax/v2/runtime-owner-leases/*.owner` files contain
  `{schemaVersion:1,pid,startToken}`; `<pid>` also appears inside the lock
  `owner_id`. PID liveness is checked via `/proc/<pid>`.

---

## 4. Operation-by-operation: native vs fallback

| Operation | Native runtime operation found | Protocol / entrypoint | Fallback when inaccessible |
|---|---|---|---|
| **list** | ✅ `session/list` (ACP). Runtime also has `listSessionPage`, `listAllSessions` | `mcode acp` JSON-RPC stdio | Direct read-only SQLite on `local_runtime_sessions` (+ enrichment columns the ACP list can't return: status, archived, session_kind, workspace, age, parent) |
| **get / inspect** | ⚠️ `session/load` exists but returns only modes/config, **no messages** | `mcode acp` | Read-only SQLite: session row + counts over `local_runtime_message_rows`, `local_runtime_token_usage`, `local_runtime_turn_diffs`, … |
| **rename / update** | Runtime `updateSession(id,{title,…})`; Desktop `PATCH .../session/:id` — **not reachable** (no listener; ACP has no rename; `setConfigOption` only covers permissionMode/model) | none accessible | Transactional `UPDATE local_runtime_sessions SET title=?, updated_at_ms=? WHERE session_id=?`, mirroring runtime semantics, and keeping `record_json` consistent (`record.title`) |
| **archive / unarchive** | Runtime `setArchived`/`archiveSession`; Desktop `POST .../session/:id/archive` — **not reachable** | none accessible | Transactional `UPDATE local_runtime_sessions SET archived=?, updated_at_ms=? WHERE session_id=?` (+ `record_json.archived`) |
| **fork / clone** | ✅ `session/fork` (ACP) → runtime `forkSession` (copies messages + turn diffs; uses suggested title) | `mcode acp` JSON-RPC stdio, params `{sessionId, cwd}` | Not reimplemented. If ACP is unavailable the tool **refuses** rather than faking a row-copy |
| **delete** | Runtime `deleteSession` chain exists; Desktop `DELETE .../session/:id` — **not reachable**; ACP `session/delete` → *Method not found* | none accessible | Transactional, schema-discovered deletion of every session-keyed row (see §5) |
| **inspect / message retrieval** | `session/load` gives no messages | — | Read-only SQLite on `local_runtime_message_rows` |

---

## 5. Deletion fallback design (mirrors runtime, strictly scoped)

1. Resolve the **exact** `mvs_*` id (never by title; no fuzzy matching).
2. Refuse if the session is active: unexpired row in
   `local_runtime_session_locks`, or `status='started'`, or a live pid in the
   owner lease / `agents` row.
3. Build a **dry-run plan by introspecting the live schema** (never hardcoded):
   - every table with a `session_id` column;
   - tables with alternate keys (`owner_session_id`, `from_session`,
     `to_session`, `local_session_id`, `target_session_id`);
   - the standalone fts5 table `local_runtime_sessions_fts` and
     `local_runtime_session_fts_keys`;
   - dependent-only children via subquery (`local_runtime_turn_ingress_sequences`
     by `turn_id`, `local_runtime_background_task_events` by `task_id`).
4. Show affected tables + exact row counts; require explicit confirmation.
5. Back up the DB file first (unless disabled), print the backup path.
6. Delete inside a single **transaction** with `busy_timeout`; on any error,
   roll back and report whether the work was fully rolled back.
7. Verify the target row is gone and representative dependents are gone;
   report exactly what was removed.

Rationale for deleting from every table rather than relying on FKs: the only
declared FK (`local_runtime_session_fts_keys`) is not enforced because
better-sqlite3 leaves `PRAGMA foreign_keys` off by default.

---

## 6. Notes / caveats

- `record_json` duplication: to keep `record_json` consistent the tool writes
  the same field into both the column and the JSON record, but treats the
  **column as authoritative** (matching observed runtime behaviour).
- The tool never modifies the mcode installation, never changes global env, and
  never kills processes.
- Exit codes are the same for human and `--json` output (delete: `0` ok,
  `1` failed, `3` refused-because-active, `4` needs `--confirm`, `5` leftovers).
- All probes above were read-only except additive ACP operations
  (`session/new`, `session/fork`); the sessions they created were used as the
  disposable targets for the mutation test suite and removed by the tool's own
  delete path (leaving the original session set intact).

## 7. Verification performed

- `tests/mutations.test.mjs` — 48 checks: rename (db + `record_json` +
  `updated_at_ms`), archive/unarchive (round-trip, idempotent, preserves other
  fields), fork (native, message copy, workspace constraint, mismatch refusal),
  delete dry-run no-op, delete refused on a live-locked session, real delete
  with backup + transactional verification, `--no-backup`, and a collateral
  check that no unrelated session disappeared.
- `tests/tui.test.mjs` — 32 checks: key decoding (arrows/ctrl-c/esc/enter/
  backspace/mixed chunks), browser rendering, search, filter clear, action
  menu, inspect screen, the two-step delete confirmation (wrong token refused,
  correct token executes), and the in-TUI active-session refusal.
- Real pty run under `script`: browser renders, ANSI colour, pagination,
  unicode box drawing, and clean exit on `q`.
- End-to-end collateral test: deleted a fork that shares turn ids with its
  source; the source's messages, `turn_ingress` and `turn_ingress_sequences`
  rows were all preserved.
