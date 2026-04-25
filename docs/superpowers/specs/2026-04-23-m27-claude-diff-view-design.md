# M27 — ε Claude diff view

**Status.** Approved 2026-04-23. The last queued post-v0.1.0 ticket
after M28 (session reorder), M30 (WebSocket session-sync push),
and M29 (deferred). Ships a retrospective changelog of file
mutations performed by Claude Code's Edit / Write / MultiEdit
tools inside each devcontainer, surfaced as a new activity-bar
pane in the dashboard.

## Context

When Claude edits files via its Edit / Write / MultiEdit tools,
the writes land directly on the container filesystem. The hub
sees nothing — there is no "what did Claude just change?" surface
in the dashboard today. Users discover Claude's edits only by
opening files manually or running `git diff` in a terminal, which
is friction for a feature whose entire point is "I want to know
what the agent did to my code."

M27 closes that gap by:

1. Planting Claude Code `PreToolUse` + `PostToolUse` hooks in
   every devcontainer via the `claude-hive` Feature.
2. Forwarding each tool call's unified diff to the hub through
   the existing hive-agent reverse-tunnel WebSocket (one new
   protocol frame: `diff_event`).
3. Persisting the last 200 events per container in a new
   `diff_events` table (Alembic migration, same pattern as M26's
   `sessions` table).
4. Rendering a chronological, date-grouped, path-searchable
   sidebar pane behind a new activity-bar icon, with an editor
   tab per event using `react-diff-view` for the diff rendering.

Codebase is at `v0.30-sessions-ws-push`.

## Goals

- Sub-second propagation of Claude file edits into a dashboard
  changelog, scoped per container.
- Reuse the existing M30 push pattern (`channel:event:data`
  frames on the multiplexed `/ws`) plus M30's 30s poll fallback.
- Reuse the M26 `named_sessions` persistence pattern (Alembic +
  async SQLAlchemy + `ix_*_container_*` index) for the
  `diff_events` table — by M27 there is one canonical "small
  persistent data" pattern in the hub.
- Single architectural seam for in-container telemetry: every
  diff event flows through the hive-agent's already-authenticated
  reverse tunnel. No new network surface in the container, no new
  shared secret to manage.

## Non-goals

- Apply / revert / comment on diff events. Read-only viewer.
  Reverting needs conflict resolution against the current file
  state, and that's its own milestone (and probably never gets
  built — the user can just ask Claude to undo).
- Per-edit attribution to a specific M26 named session. The hook
  knows Claude's internal `session_id` (informational only,
  stored in `claude_session_id` column for future correlation),
  but the bridge from "which Claude session" → "which M26 named
  session" is not built and not needed for ε scope.
- Diff events from non-Claude file mutations (the M24 dashboard
  CodeEditor save path, manual terminal edits, git operations,
  external script writes). Only the three named tools — Edit,
  Write, MultiEdit — emit events.
- Binary file diffs. Hook detects via "first 8 KiB has `\0`" and
  silently skips.
- Cross-container changelog. Events are scoped per container; no
  global view, no cross-container search.

## Design

### 1. Architecture

```
Inside container N
┌────────────────────────────────────────────────────┐
│  Claude Code (running in PTY session)              │
│      │ tool call (Edit/Write/MultiEdit)            │
│      ▼                                             │
│  PreToolUse hook  →  /run/honeycomb/staging/       │
│    snapshots ${path} → ${tool_use_id}.before       │
│      │                                             │
│  (tool runs, writes file)                          │
│      │                                             │
│  PostToolUse hook                                  │
│    diff -u .before <current>                       │
│    skip if empty / binary                          │
│    `hive-agent submit-diff --tool=… --path=… \     │
│      --tool-use-id=… --diff=-`                     │
│      │                                             │
│      ▼                                             │
│  hive-agent CLI shim                               │
│    Unix socket /run/honeycomb/agent.sock           │
│      │                                             │
│      ▼                                             │
│  hive-agent daemon (already running, auth WS)      │
│    forwards over reverse tunnel as                 │
│    `{kind: "diff_event", …}` frame                 │
└──────────────────────────────────┼─────────────────┘
                                   │
                                   ▼
On the host
┌────────────────────────────────────────────────────┐
│  Hub: /api/agent/connect WS handler                │
│    routes `kind=diff_event` to                     │
│    diff_events.record_event(...)                   │
│      │                                             │
│  Hub: services/diff_events.py                      │
│    INSERT INTO diff_events ...                     │
│    DELETE oldest beyond 200/container              │
│    broadcast WSFrame(channel="diff-events:<cid>",  │
│       event="new", data=<row>)                     │
│      │                                             │
│      ▼                                             │
│  Dashboard: useDiffEvents(containerId)             │
│    REST GET /api/containers/{id}/diff-events       │
│      with 30s staleTime + refetchOnWindowFocus     │
│    + WS subscribe to "diff-events:<cid>"           │
│    on `new` frame, prepend to TanStack cache       │
└────────────────────────────────────────────────────┘

Dashboard UI
┌─ ActivityBar ──┬─ DiffEventsActivity (sidebar) ─┐
│ … existing  …  │  Date-grouped list             │
│ Diff icon (new)┤  Path filter input at top      │
│                │  click row → opens DiffTab     │
└────────────────┴────────────────────────────────┘
                    │
                    ▼
       DiffViewerTab (editor area)
       header: [tool icon] path · timestamp
               [Unified | Split] [Open file]
                                 [Copy patch]
       body: react-diff-view rendering the diff
```

### 2. Data model — `diff_events` table

New Alembic migration:

```sql
CREATE TABLE diff_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  claude_session_id TEXT,
  tool_use_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  path TEXT NOT NULL,
  diff TEXT NOT NULL,
  added_lines INTEGER NOT NULL DEFAULT 0,
  removed_lines INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (tool IN ('Edit', 'Write', 'MultiEdit'))
);

CREATE INDEX ix_diff_events_container_created
  ON diff_events (container_id, created_at DESC);
```

Notes:

- `event_id` is server-generated `uuid4().hex`, returned in REST
  responses and WS frames so clients can dedupe across the push +
  poll paths.
- `tool_use_id` comes from Claude Code's hook payload. It is the
  natural primary key for "which tool invocation" but Claude can
  re-issue an id under unusual conditions, so it is not unique-
  constrained — we let `event_id` be the row identity.
- `claude_session_id` is informational; nullable because not all
  Claude versions emit it consistently.
- `diff` is the unified-diff text, not a parsed structure. It is
  parsed on demand in the browser by `gitdiff-parser` when the
  user opens a viewer tab.
- `added_lines` / `removed_lines` are pre-computed at the hook
  level (cheap, since the diff already exists there) so the
  sidebar can show `+14 −8` without re-parsing every diff.

### 3. WS protocol extension — `diff_event` frame

#### Agent → hub

Forwarded over the existing reverse tunnel established in M4. New
`kind` value alongside `cmd_exec`, `output`, `done`, `heartbeat`:

```json
{
  "kind": "diff_event",
  "tool_use_id": "toolu_01ABC…",
  "claude_session_id": "session_uuid",
  "tool": "Edit",
  "path": "/workspace/dashboard/src/App.tsx",
  "diff": "--- a/dashboard/src/App.tsx\n+++ b/…",
  "added_lines": 14,
  "removed_lines": 8,
  "timestamp": "2026-04-23T07:38:00.123Z"
}
```

The `container_id` is **not** in the frame — the hub's WS handler
already knows it from the agent's authenticated session, so any
client-supplied `container_id` would be ignored anyway. This
matches the M4 pattern.

#### Hub → dashboard (broadcast on `diff-events:<cid>` channel)

```json
{
  "channel": "diff-events:42",
  "event": "new",
  "data": {
    "event_id": "…",
    "container_id": 42,
    "tool": "Edit",
    "path": "/workspace/dashboard/src/App.tsx",
    "diff": "…",
    "added_lines": 14,
    "removed_lines": 8,
    "size_bytes": 1023,
    "timestamp": "…",
    "created_at": "…"
  }
}
```

Broadcast failures are logged + swallowed via the same helper
pattern M30 introduced — agent → hub → DB write must succeed
independent of dashboard delivery.

### 4. CLI shim — `hive-agent submit-diff`

New subcommand of the existing `hive-agent` CLI. Reads a unified
diff from stdin (or from a file via `--diff @path`); composes a
`diff_event` payload; sends it over the agent's existing Unix
socket to the running daemon, which forwards it over the reverse
tunnel.

```
hive-agent submit-diff \
  --tool=Edit \
  --path=/workspace/foo.py \
  --tool-use-id=toolu_01ABC \
  --claude-session-id=session_uuid \
  --added-lines=14 \
  --removed-lines=8 \
  --diff=-                  # read stdin
```

Failure semantics:

- Agent socket missing or unreachable → log to stderr, exit 1.
- Daemon connected but not running the WS forwarder → log, exit 1.
- Successful enqueue (does not wait for hub ack) → exit 0.

The hook script that invokes this is required to swallow the
exit code: failure to record a diff event must NEVER break
Claude's workflow.

### 5. Hook scripts

The `claude-hive` Feature plants two hook scripts in
`/usr/local/share/honeycomb/hooks/` and registers them in
`~/.claude/settings.json`. The Feature install merges into any
existing `hooks` block rather than overwriting, so user-defined
hooks are preserved.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "/usr/local/share/honeycomb/hooks/diff-pre" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "/usr/local/share/honeycomb/hooks/diff-post" }]
      }
    ]
  }
}
```

#### `diff-pre` (Python, ~30 lines)

- Read JSON payload from stdin (Claude Code passes
  `{tool_name, tool_input, tool_use_id, session_id, …}`).
- Extract `path = tool_input.file_path`.
- If `path` exists and is a regular file: copy contents to
  `/run/honeycomb/staging/${tool_use_id}.before` (mkdir -p the
  staging dir; perms 0700).
- If `path` doesn't exist (Write to a new file) or is a
  directory: do nothing — `diff-post` will see no `.before` and
  treat it as an insert.
- exit 0 unconditionally (errors must not block the tool).

#### `diff-post` (Python, ~80 lines)

- Read JSON payload from stdin.
- Extract `tool_use_id`, `tool_name`, `tool_input.file_path`,
  `session_id`.
- Locate `/run/honeycomb/staging/${tool_use_id}.before`. May be
  absent (newly created file) — treat as empty `before`.
- Read current file contents. May be absent (Write that deleted /
  replaced with empty) — treat as empty `after`.
- Binary check: if either side has `\0` in first 8 KiB, exit 0
  without submitting.
- Compute `difflib.unified_diff(before, after, fromfile=…,
tofile=…)`. If empty (no real change), exit 0.
- Count `+` / `−` lines (excluding `+++` / `---` headers).
- Cap at 256 KiB encoded; if larger, replace `diff` with the
  string `[diff exceeds 256 KiB cap; not stored]` and zero the
  line counts. The event is still recorded so the user sees
  "edit happened" even when the body was too big.
- Invoke `hive-agent submit-diff …` via subprocess; ignore exit
  code.
- Cleanup `${tool_use_id}.before` regardless of submit success.

### 6. Hub side — service + router + WS handler

#### `hub/services/diff_events.py` (new)

- `record_event(engine, *, container_id, frame: DiffEventFrame) -> DiffEvent`:
  generates `event_id`, computes `size_bytes`, INSERTs, then
  prunes oldest rows beyond the 200/container cap in the same
  transaction. Returns the populated row.
- `list_events(engine, *, container_id, limit=200) -> list[DiffEvent]`:
  newest-first.

Pruning SQL (single statement per insert):

```sql
DELETE FROM diff_events
WHERE container_id = :cid
  AND id NOT IN (
    SELECT id FROM diff_events
    WHERE container_id = :cid
    ORDER BY id DESC LIMIT 200
  );
```

#### `hub/routers/diff_events.py` (new)

- `GET /api/containers/{record_id}/diff-events` →
  `list[DiffEvent]`, newest first.
- No POST endpoint — events arrive via the agent WS, not REST.
  This keeps the endpoint surface small and prevents a "client
  forges an event for a container it shouldn't be writing to"
  attack vector.

#### `hub/routers/agent.py` (modify)

In the existing agent-WS message dispatcher, add a `kind ==
"diff_event"` case alongside `output`, `done`, `heartbeat`:

```python
elif msg.kind == "diff_event":
    event = await diff_events.record_event(
        registry.engine, container_id=container_id, frame=msg
    )
    await _broadcast_diff_event(event)
```

`_broadcast_diff_event` is a small helper (mirrors M30's
`_broadcast_sessions_list`):

```python
async def _broadcast_diff_event(event: DiffEvent) -> None:
    try:
        frame = WSFrame(
            channel=f"diff-events:{event.container_id}",
            event="new",
            data=event.model_dump(mode="json"),
        )
        await ws_manager.broadcast(frame)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to broadcast diff event %s: %s",
                       event.event_id, exc)
```

### 7. Dashboard

#### `dashboard/src/hooks/useDiffEvents.ts` (new)

- TanStack Query for `GET /api/containers/{id}/diff-events`,
  `staleTime: 30_000`, `refetchOnWindowFocus: true`.
- WS subscription to `diff-events:<containerId>` via
  `useHiveWebSocket()`.
- On `event === "new"`, prepend `frame.data` to the cached
  array, capped client-side at 200 (mirroring server cap to
  protect against runaway memory if a chatty container fires
  hundreds of events between refetches).
- Returns `{events, isLoading, error}`.

#### `dashboard/src/components/DiffEventsActivity.tsx` (new)

- New activity-bar entry. Icon: `lucide-react` (final pick during
  the frontend-design pass — candidates are `<History>`,
  `<GitCompare>`, `<FileDiff>`).
- Sidebar pane structure:
  - Header: search input (`<input>` bound to local state, filters
    `events` by `path.toLowerCase().includes(query.toLowerCase())`).
  - Body: date-grouped list (`Today`, `Yesterday`, `This week`,
    `Older`) with sticky group headers. Date assignment via
    `created_at` and host-local time.
  - Each row: `[tool icon] {short path} {relative time}` plus
    `+{added} −{removed}` in muted text on the right.
  - Click → opens a tab in the editor area (uses the same
    `openTab` infrastructure as M16/M18). Tab key:
    `diff-event:<event_id>`.

#### `dashboard/src/components/DiffViewerTab.tsx` (new)

- Header layout: `{tool icon} {path}` left, `{absolute timestamp · relative}`
  middle, `[Unified | Split]` segmented control + `Open file` +
  `Copy patch` buttons right.
- Body: `<DiffView>` from `react-diff-view`, parsed via
  `gitdiff-parser`'s `parseDiff(diff_text)`. View mode bound to
  the segmented control's state.
- Token rendering: `react-diff-view`'s `tokenize` helper plus
  `prismjs` for syntax highlighting based on the file extension.
- "Open file" calls the existing `openFileInViewer(path)` from
  the M18 file-viewer infrastructure.
- "Copy patch" uses `navigator.clipboard.writeText(diff)` and
  shows a toast on success ("Diff copied").
- View-mode preference persists via the existing
  `useLocalStorage<"unified" | "split">("hive:diff-view-mode", "unified")`
  hook.

#### `dashboard/src/components/ActivityBar.tsx` (modify)

Register the new activity entry alongside the existing ones
(Containers, Source Control, etc.). Keyboard shortcut: extend the
existing `Ctrl+Shift+<n>` activity-switching scheme.

#### `dashboard/src/App.tsx` (modify)

Slot the new activity into the same conditional sidebar render
that handles existing activities — one `if (activeActivity ===
"diff-events") return <DiffEventsActivity />` branch.

#### `dashboard/package.json` (modify)

Add three runtime deps:

- `react-diff-view` — the rendering library
- `gitdiff-parser` — its companion parser
- `prismjs` — syntax highlighting (already a transitive dep of
  several other packages, but pin it as a direct dep here so the
  diff viewer's token grammar imports are explicit)

### 8. Error handling + edge cases

| Case                                       | Behaviour                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hub down when hook fires                   | `hive-agent submit-diff` exits non-zero; hook swallows; event lost. The 30s poll + WS reconnect see nothing new because nothing was persisted. Acceptable trade-off for ε scope.                                                                                         |
| Pre-hook failed to capture (perms / race)  | `diff-post` sees no `${tool_use_id}.before`; treats current file as full insert (empty `before`, full `after` → all `+` lines). Same shape as a `Write` to a new file — semantically correct.                                                                            |
| File deleted by tool                       | `diff-post` sees missing current file; treats as full removal (full `before` → all `−` lines, empty `after`).                                                                                                                                                            |
| Tool was a no-op (file unchanged)          | `difflib.unified_diff` returns empty; hook exits 0 without submitting. No event in the changelog.                                                                                                                                                                        |
| Binary file                                | First-8-KiB-has-`\0` heuristic on either side returns true; hook exits 0 without submitting.                                                                                                                                                                             |
| Diff exceeds 256 KiB                       | Hook replaces diff text with `[diff exceeds 256 KiB cap; not stored]` and zeroes line counts. Event is still recorded — user sees "edit happened on path X" with a marker explaining why the body is empty.                                                              |
| MultiEdit                                  | One `tool_use_id`, one before-snapshot, one after-state, one merged unified diff covering all atomic edits in the call. One row in `diff_events`, one event in the sidebar.                                                                                              |
| Multiple containers writing simultaneously | Each container has its own table rows, its own WS channel, its own sidebar instance. No cross-container interference.                                                                                                                                                    |
| Hub restart                                | Events in `diff_events` survive (Alembic migration handles upgrades on boot, same as M26/M28). Open WS connections drop and re-establish via `useHiveWebSocket`'s built-in reconnect; the 30s poll fallback catches anything missed in the reconnect gap.                |
| Agent socket has wrong perms               | Daemon creates `/run/honeycomb/agent.sock` mode 0660 owned by the same user that runs Claude Code (root in the dev container, per project convention). Hook fails the connect → exit 1 → silent.                                                                         |
| User has their own `PreToolUse` hook       | Feature install merges into existing `hooks.PreToolUse` array rather than overwriting. Multiple matching hooks in the array fire in order; ours coexists with user hooks.                                                                                                |
| Settings.json doesn't exist yet            | Feature install creates `~/.claude/settings.json` with just our hooks block.                                                                                                                                                                                             |
| Diff in WS frame > some frame size limit   | Frames go through the same `ConnectionManager.broadcast` as every other channel; per-client send timeout is 2s (M11). Slow / dead clients are disconnected. Diff size is capped at 256 KiB before it reaches the wire, so frame size stays well under any practical cap. |

### 9. Testing summary

#### `pytest`

- `hub/tests/test_diff_events_service.py` — record + list +
  auto-eviction at 201 events; cascade delete on container drop.
- `hub/tests/test_diff_events_endpoint.py` — GET endpoint with
  fixture data; auth (no token → 401); unknown container → 404.
- `hub/tests/test_agent_diff_event_intake.py` — agent-WS handler
  routes a `kind=diff_event` frame to `record_event` and triggers
  the broadcast helper. Mocks `ws_manager` per the M30 fixture
  pattern.
- `hub/tests/test_diff_events_broadcast.py` — broadcast helper
  (failure does not raise, frame shape is correct, channel is
  `diff-events:<cid>`).

#### `hive-agent` pytest

- `hive-agent/tests/test_submit_diff_cli.py` — `submit-diff` CLI
  with mocked socket round-trips a frame; exits non-zero when
  the socket is missing.
- `hive-agent/tests/test_diff_event_protocol.py` — Pydantic
  `DiffEventFrame` model byte-compatibility with the hub's
  schema (extends the existing M4 protocol-parity test).

#### Hook scripts

- `bootstrapper/tests/test_hooks_diff.py` — pytest harness that
  spawns `diff-pre` and `diff-post` with synthetic stdin
  payloads, confirms the pre snapshot lands in the staging dir,
  confirms `diff-post` calls a fake `submit-diff` shim with the
  expected args. Covers: normal Edit, Write to a new file, file
  deletion, binary file (skipped), no-op (skipped), oversize
  (truncated marker), missing pre snapshot.

#### `vitest`

- `dashboard/src/hooks/__tests__/useDiffEvents.test.tsx` — REST
  fetch, WS subscription, cache prepend on `new`, cache cap at
  200, unsubscribes on container change.
- `dashboard/src/components/__tests__/DiffEventsActivity.test.tsx`
  — date grouping, path filter, click opens the right tab.
- `dashboard/src/components/__tests__/DiffViewerTab.test.tsx` —
  renders unified + split, copy-patch action, open-file action,
  view-mode preference persists.

#### Playwright

- `dashboard/tests/e2e/diff-events.spec.ts` — happy path: with a
  fixture that simulates an agent emitting a `diff_event` frame,
  click the activity-bar icon, assert the row appears in the
  sidebar within 2s, click the row, assert the diff renders, hit
  the unified/split toggle, hit copy-patch, assert clipboard
  contents match.

#### Manual smoke

- Register a real container, open the dashboard, run `claude` in
  a terminal, ask Claude to edit a file. Watch the new event
  appear in the sidebar within ~1s. Click it, see the diff. Hit
  split mode, see side-by-side. Open file, see the M18 viewer.

## Critical files

### Hub

- [hub/db/migrations/versions/](../../../hub/db/migrations/versions/) — new revision file `<rev>_m27_diff_events.py`
- [hub/db/schema.py](../../../hub/db/schema.py) — add `diff_events` Table object
- [hub/services/diff_events.py](../../../hub/services/) — new module
- [hub/routers/diff_events.py](../../../hub/routers/) — new GET router
- [hub/routers/agent.py](../../../hub/routers/agent.py) — handle `diff_event` frame in WS dispatch + add `_broadcast_diff_event`
- [hub/models/schemas.py](../../../hub/models/schemas.py) — `DiffEvent` + `DiffEventFrame` Pydantic models
- [hub/main.py](../../../hub/main.py) — register the new router

### hive-agent

- [hive-agent/hive_agent/cli.py](../../../hive-agent/hive_agent/cli.py) — add `submit-diff` subcommand
- [hive-agent/hive_agent/protocol.py](../../../hive-agent/hive_agent/protocol.py) — `DiffEventFrame` model
- [hive-agent/hive_agent/ws_client.py](../../../hive-agent/hive_agent/ws_client.py) — `submit_diff()` method to forward over WS
- [hive-agent/hive_agent/socket_listener.py](../../../hive-agent/hive_agent/) — new Unix-socket listener that the daemon runs alongside its WS loop

### Bootstrapper

- [bootstrapper/claude-hive-feature/install.sh](../../../bootstrapper/claude-hive-feature/install.sh) — plant hook scripts + register in `~/.claude/settings.json` via merge (not overwrite)
- [bootstrapper/claude-hive-feature/hooks/diff-pre](../../../bootstrapper/claude-hive-feature/) — new
- [bootstrapper/claude-hive-feature/hooks/diff-post](../../../bootstrapper/claude-hive-feature/) — new

### Dashboard

- [dashboard/src/components/DiffEventsActivity.tsx](../../../dashboard/src/components/) — new sidebar pane
- [dashboard/src/components/DiffViewerTab.tsx](../../../dashboard/src/components/) — new editor tab
- [dashboard/src/hooks/useDiffEvents.ts](../../../dashboard/src/hooks/) — new hook
- [dashboard/src/components/ActivityBar.tsx](../../../dashboard/src/components/ActivityBar.tsx) — register the new activity entry
- [dashboard/src/App.tsx](../../../dashboard/src/App.tsx) — render the new sidebar conditional
- [dashboard/src/lib/types.ts](../../../dashboard/src/lib/types.ts) — `DiffEvent` TypeScript type
- [dashboard/src/lib/api.ts](../../../dashboard/src/lib/api.ts) — `listDiffEvents` REST wrapper
- [dashboard/package.json](../../../dashboard/package.json) — add `react-diff-view`, `gitdiff-parser`, `prismjs`

## Verification

Same shape as M20–M30:

1. `pre-commit run --all-files` clean.
2. `cd hub && uv run ruff check . && uv run mypy .` clean.
3. `cd hub && uv run pytest tests -q` green (360 + new tests).
4. `cd hive-agent && uv run pytest tests -q` green.
5. `cd dashboard && npx tsc -b --noEmit && npm run lint && npx vitest run` green.
6. `cd dashboard && npx playwright test` green.
7. `cd dashboard && npx prettier --write .` before push.
8. Manual: register a container, edit a file via Claude Code,
   watch the event appear in the sidebar within ~1s. Click,
   render, toggle split, copy patch.
9. Branch merged `--no-ff` to `main`; tagged `v0.27-claude-diff-view`;
   `git push --follow-tags`; CI watched; branch deleted.

## Follow-up tickets

None — this is the last item from the post-v0.1.0 sweep. After
M27 ships, the queue is empty.
