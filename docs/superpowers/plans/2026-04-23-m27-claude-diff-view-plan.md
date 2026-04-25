# M27 — ε Claude diff view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **For dashboard tasks (T11–T16):** consult the approved mockup at `.superpowers/brainstorm/*/content/m27-dashboard.html` for visual details — tool color gutter, segmented toggle, toast on copy-patch, date-group sticky headers, syntax-highlighted diff body. Use the `frontend-design` skill when implementing components to match the mockup's polish.

**Goal:** Ship a retrospective changelog of Claude's `Edit` / `Write` / `MultiEdit` tool calls per devcontainer, surfaced as a new dashboard activity-bar pane with a date-grouped, path-searchable sidebar and per-event diff viewer (unified ↔ split toggle, open-file + copy-patch actions).

**Architecture:** PostToolUse hook in each container → `hive-agent submit-diff` CLI → Unix socket `/run/honeycomb/agent.sock` → hive-agent daemon → existing reverse-tunnel WebSocket → hub → `diff_events` Alembic table → WS broadcast on `diff-events:<cid>` channel + 30 s poll fallback → React sidebar + viewer.

**Tech Stack:** SQLAlchemy async + Alembic + Pydantic v2 + structlog (hub), `click` + `websockets` + `asyncio` + Unix sockets (hive-agent), Bash + `set -euo pipefail` + Python 3 (bootstrapper hooks), React 19 + TanStack Query v5 + `react-diff-view` + `gitdiff-parser` + `prismjs` + Tailwind v4 + `lucide-react` (dashboard), Vitest + Playwright + pytest-asyncio (tests).

**Branch:** `m27-claude-diff-view` (create from `main` at `v0.30-sessions-ws-push`).

**Spec:** [docs/superpowers/specs/2026-04-23-m27-claude-diff-view-design.md](../specs/2026-04-23-m27-claude-diff-view-design.md)

**Spec→plan corrections.** Two contract details where the plan deviates from the spec to match the codebase's existing conventions:

1. **Frame discriminator field is `type`, not `kind`** (the existing `AgentFrame` discriminated union in `hub/models/agent_protocol.py` uses `type: Literal[…]`; the spec's `kind` was incorrect).
2. **`DiffEventFrame` (wire) lives in `hub/models/agent_protocol.py` + mirror in `hive-agent/hive_agent/protocol.py`**, not in `hub/models/schemas.py`. **`DiffEvent` (API row)** stays in `hub/models/schemas.py`.

Both corrections preserve the spec's _intent_ (one new frame type; persistent rows; broadcast on a channel); they just route the code to the canonical files.

---

## File Structure

### Hub (Python)

- **Create** `hub/db/migrations/versions/2026_04_23_1200-m27_diff_events.py` — Alembic migration adding the `diff_events` table + index.
- **Modify** `hub/db/schema.py` — append the `diff_events` Table object so service code can reference it.
- **Create** `hub/services/diff_events.py` — `record_event` + `list_events` + 200/container auto-eviction.
- **Create** `hub/routers/diff_events.py` — `GET /api/containers/{record_id}/diff-events`.
- **Modify** `hub/models/schemas.py` — add `DiffEvent` Pydantic model (API/DB row shape).
- **Modify** `hub/models/agent_protocol.py` — add `DiffEventFrame` + extend `AgentFrame` discriminated union.
- **Modify** `hub/routers/agent.py` — add `isinstance(frame, DiffEventFrame)` dispatch + `_broadcast_diff_event` helper.
- **Modify** `hub/main.py` — register the new router.
- **Create** `hub/tests/test_diff_events_service.py` — record + list + auto-eviction + cascade.
- **Create** `hub/tests/test_diff_events_endpoint.py` — GET endpoint + auth + 404.
- **Create** `hub/tests/test_agent_diff_event_intake.py` — agent WS routes diff_event + broadcasts.
- **Modify** `hub/tests/test_agent_protocol.py` (or create) — DiffEventFrame parity test (hub vs hive-agent byte-compat).

### hive-agent (Python)

- **Modify** `hive-agent/hive_agent/protocol.py` — mirror `DiffEventFrame` from the hub side.
- **Modify** `hive-agent/hive_agent/ws_client.py` — add `submit_diff(...)` method that pushes a `DiffEventFrame` over the live WS.
- **Create** `hive-agent/hive_agent/socket_listener.py` — Unix-socket coroutine listening on `/run/honeycomb/agent.sock`, parses incoming JSON `submit-diff` requests, calls `client.submit_diff(...)`.
- **Modify** `hive-agent/hive_agent/cli.py` — add the `submit-diff` `click` subcommand that connects to the socket and writes a JSON line.
- **Create** `hive-agent/tests/test_submit_diff_cli.py` — CLI round-trips a frame via a mocked socket.
- **Create** `hive-agent/tests/test_socket_listener.py` — listener accepts a write, parses, calls `submit_diff`.

### Bootstrapper (Bash + Python)

- **Create** `bootstrapper/claude-hive-feature/hooks/diff-pre` — Python script (executable) that snapshots the file before the tool runs.
- **Create** `bootstrapper/claude-hive-feature/hooks/diff-post` — Python script (executable) that diffs and invokes `hive-agent submit-diff`.
- **Modify** `bootstrapper/claude-hive-feature/install.sh` — copy hooks into `/usr/local/share/honeycomb/hooks/` and idempotently merge a `hooks` block into `~/.claude/settings.json`.
- **Create** `bootstrapper/tests/test_hooks_diff.py` — pytest harness exercising both hooks with synthetic stdin payloads (including: normal Edit, Write to new file, deletion, binary skip, no-op, oversize cap, missing pre snapshot).

### Dashboard (TypeScript / React)

- **Modify** `dashboard/package.json` — add `react-diff-view`, `gitdiff-parser`, `prismjs`.
- **Modify** `dashboard/src/lib/types.ts` — `DiffEvent` TypeScript type.
- **Modify** `dashboard/src/lib/api.ts` — `listDiffEvents` REST wrapper.
- **Create** `dashboard/src/hooks/useDiffEvents.ts` — REST + WS subscription, prepend-on-`new`, 200-cap.
- **Create** `dashboard/src/components/DiffViewerTab.tsx` — `react-diff-view` rendering, unified↔split toggle, open-file + copy-patch.
- **Create** `dashboard/src/components/DiffEventsActivity.tsx` — date-grouped, path-filterable sidebar with the tool-color gutter.
- **Modify** `dashboard/src/components/ActivityBar.tsx` — register the new icon.
- **Modify** `dashboard/src/App.tsx` — render the sidebar conditional on `activeActivity === "diff-events"`; route row-click → tab open.
- **Create** `dashboard/src/hooks/__tests__/useDiffEvents.test.tsx` — fetch + WS prepend + 200-cap.
- **Create** `dashboard/src/components/__tests__/DiffViewerTab.test.tsx` — render + toggle + actions.
- **Create** `dashboard/src/components/__tests__/DiffEventsActivity.test.tsx` — grouping + filter + click-to-open.
- **Create** `dashboard/tests/e2e/diff-events.spec.ts` — Playwright happy path.

---

## Task 0: Create the branch

- [ ] **Step 1: Branch from main at `v0.30-sessions-ws-push`**

```bash
cd /home/gnava/repos/honeycomb
git checkout main
git pull --ff-only origin main
git checkout -b m27-claude-diff-view
git log --oneline -1
```

Expected output: HEAD is `78715be Merge M30: WebSocket session-sync push`.

---

## Task 1: Alembic migration for the `diff_events` table

**Files:**

- Create: `hub/db/migrations/versions/2026_04_23_1200-m27_diff_events.py`
- Modify: `hub/db/schema.py`
- Test: smoke-test that the migration applies cleanly to a fresh DB.

- [ ] **Step 1: Inspect the existing M28 migration for style reference**

```bash
cat hub/db/migrations/versions/2026_04_21_1200-m28_session_position.py
```

This is the canonical pattern: `revision`, `down_revision`, `upgrade()` with `op.create_table(...)` / `op.add_column(...)` / `op.create_index(...)`.

- [ ] **Step 2: Write a smoke test that asserts the new table exists post-migration**

Append to `hub/tests/test_m28_session_position_migration.py`? No — create a new file so failures attribute clearly.

Create `hub/tests/test_m27_diff_events_migration.py`:

```python
"""Smoke test for the M27 diff_events table migration."""

from __future__ import annotations

from pathlib import Path

import sqlalchemy as sa

from hub.db.migrations_runner import apply_migrations_sync


def test_diff_events_table_exists_after_migration(tmp_path: Path) -> None:
    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)

    eng = sa.create_engine(f"sqlite:///{db_path}")
    inspector = sa.inspect(eng)

    assert "diff_events" in inspector.get_table_names()

    cols = {c["name"]: c for c in inspector.get_columns("diff_events")}
    expected = {
        "id",
        "event_id",
        "container_id",
        "claude_session_id",
        "tool_use_id",
        "tool",
        "path",
        "diff",
        "added_lines",
        "removed_lines",
        "size_bytes",
        "timestamp",
        "created_at",
    }
    assert expected.issubset(cols.keys()), f"missing columns: {expected - cols.keys()}"
    assert cols["claude_session_id"]["nullable"] is True

    indexes = {ix["name"] for ix in inspector.get_indexes("diff_events")}
    assert "ix_diff_events_container_created" in indexes
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_m27_diff_events_migration.py -v
```

Expected: FAIL — `'diff_events' not in inspector.get_table_names()`.

- [ ] **Step 4: Create the migration file**

Create `hub/db/migrations/versions/2026_04_23_1200-m27_diff_events.py`:

```python
"""M27 — diff_events table for the Claude diff changelog.

Records each Edit/Write/MultiEdit tool call's unified diff so the
dashboard can render a per-container changelog. 200-event cap is
enforced at insert time by the service layer (no DB-level constraint).

Revision ID: m27_diff_events
Revises: m28_position
Create Date: 2026-04-23 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "m27_diff_events"
down_revision: str | Sequence[str] | None = "m28_position"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "diff_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("event_id", sa.Text, nullable=False, unique=True),
        sa.Column(
            "container_id",
            sa.Integer,
            sa.ForeignKey("containers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("claude_session_id", sa.Text, nullable=True),
        sa.Column("tool_use_id", sa.Text, nullable=False),
        sa.Column("tool", sa.Text, nullable=False),
        sa.Column("path", sa.Text, nullable=False),
        sa.Column("diff", sa.Text, nullable=False),
        sa.Column("added_lines", sa.Integer, nullable=False, server_default="0"),
        sa.Column("removed_lines", sa.Integer, nullable=False, server_default="0"),
        sa.Column("size_bytes", sa.Integer, nullable=False),
        sa.Column("timestamp", sa.Text, nullable=False),
        sa.Column("created_at", sa.Text, nullable=False),
        sa.CheckConstraint(
            "tool IN ('Edit', 'Write', 'MultiEdit')",
            name="ck_diff_events_tool",
        ),
    )
    op.create_index(
        "ix_diff_events_container_created",
        "diff_events",
        ["container_id", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_diff_events_container_created", table_name="diff_events")
    op.drop_table("diff_events")
```

- [ ] **Step 5: Append the table object to `hub/db/schema.py`**

In `hub/db/schema.py`, after the existing `sessions` table definition, add:

```python
diff_events = sa.Table(
    "diff_events",
    metadata,
    sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column("event_id", sa.Text, nullable=False, unique=True),
    sa.Column(
        "container_id",
        sa.Integer,
        sa.ForeignKey("containers.id", ondelete="CASCADE"),
        nullable=False,
    ),
    sa.Column("claude_session_id", sa.Text, nullable=True),
    sa.Column("tool_use_id", sa.Text, nullable=False),
    sa.Column("tool", sa.Text, nullable=False),
    sa.Column("path", sa.Text, nullable=False),
    sa.Column("diff", sa.Text, nullable=False),
    sa.Column("added_lines", sa.Integer, nullable=False, server_default="0"),
    sa.Column("removed_lines", sa.Integer, nullable=False, server_default="0"),
    sa.Column("size_bytes", sa.Integer, nullable=False),
    sa.Column("timestamp", sa.Text, nullable=False),
    sa.Column("created_at", sa.Text, nullable=False),
    sa.CheckConstraint("tool IN ('Edit', 'Write', 'MultiEdit')", name="ck_diff_events_tool"),
    sa.Index("ix_diff_events_container_created", "container_id", sa.text("created_at DESC")),
)
```

- [ ] **Step 6: Run the test and confirm it passes**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_m27_diff_events_migration.py -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/db/migrations/versions/2026_04_23_1200-m27_diff_events.py \
        hub/db/schema.py \
        hub/tests/test_m27_diff_events_migration.py
git commit -m "feat(m27): diff_events table migration

Adds Alembic revision m27_diff_events with the table that holds
per-container Claude tool-call diffs (Edit/Write/MultiEdit). 200-
event cap is enforced at insert time by the service layer; the
table itself has only the FK cascade and the (container_id,
created_at DESC) index needed for newest-first list queries."
```

---

## Task 2: Pydantic models — `DiffEvent` (API row) + `DiffEventFrame` (wire) + protocol mirror

**Files:**

- Modify: `hub/models/schemas.py` — add `DiffEvent`.
- Modify: `hub/models/agent_protocol.py` — add `DiffEventFrame` + extend `AgentFrame` union.
- Modify: `hive-agent/hive_agent/protocol.py` — mirror `DiffEventFrame`.
- Test: `hub/tests/test_agent_protocol.py` — extend the existing parity test.

- [ ] **Step 1: Inspect existing parity test**

```bash
cat hub/tests/test_agent_protocol.py 2>/dev/null | head -40
```

If the file does not exist, the parity check lives elsewhere. Search:

```bash
grep -rln "byte-compatible\|byte_compatible\|DoneFrame.*round" hub/tests hive-agent/tests
```

Confirm where the existing parity test lives (typically `hub/tests/test_agent_protocol.py` paired with `hive-agent/tests/test_agent_protocol.py`).

- [ ] **Step 2: Write the failing parity test for DiffEventFrame**

Append to `hub/tests/test_agent_protocol.py` (create the file if it does not exist):

```python
def test_diff_event_frame_parity_hub_and_agent() -> None:
    """DiffEventFrame must round-trip identically through the hub's
    Pydantic model and the hive-agent's mirror — bytes match exactly."""
    from hub.models.agent_protocol import DiffEventFrame as HubFrame
    from hive_agent.protocol import DiffEventFrame as AgentFrame

    payload = {
        "type": "diff_event",
        "container_id": "c-42",
        "tool_use_id": "toolu_01ABC",
        "claude_session_id": "session_uuid",
        "tool": "Edit",
        "path": "/workspace/foo.py",
        "diff": "--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-x\n+y\n",
        "added_lines": 1,
        "removed_lines": 1,
        "timestamp": "2026-04-23T07:38:00.123Z",
    }
    hub_frame = HubFrame.model_validate(payload)
    agent_frame = AgentFrame.model_validate(payload)
    assert hub_frame.model_dump_json() == agent_frame.model_dump_json()
```

- [ ] **Step 3: Run the test and confirm it fails**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_agent_protocol.py::test_diff_event_frame_parity_hub_and_agent -v
```

Expected: FAIL — `ImportError: cannot import name 'DiffEventFrame'`.

- [ ] **Step 4: Add `DiffEventFrame` to `hub/models/agent_protocol.py`**

In `hub/models/agent_protocol.py`, between `DoneFrame` and the "hub → agent" section comment, add:

```python
class DiffEventFrame(BaseModel):
    """M27 — Edit/Write/MultiEdit tool call captured by an in-container
    PostToolUse hook and forwarded over the agent's reverse tunnel."""

    type: Literal["diff_event"] = "diff_event"
    container_id: str
    tool_use_id: str
    claude_session_id: str | None = None
    tool: Literal["Edit", "Write", "MultiEdit"]
    path: str
    diff: str
    added_lines: int = 0
    removed_lines: int = 0
    timestamp: str
```

Then in the same file, extend the `AgentFrame` union to include `DiffEventFrame`:

```python
AgentFrame = Annotated[
    HelloFrame
    | HeartbeatFrame
    | AckFrame
    | OutputFrame
    | DoneFrame
    | DiffEventFrame
    | CmdExecFrame
    | CmdKillFrame
    | PongFrame,
    Field(discriminator="type"),
]
```

- [ ] **Step 5: Mirror `DiffEventFrame` in `hive-agent/hive_agent/protocol.py`**

Add the identical model in `hive-agent/hive_agent/protocol.py`, in the `agent → hub` section (after `DoneFrame`):

```python
class DiffEventFrame(BaseModel):
    type: Literal["diff_event"] = "diff_event"
    container_id: str
    tool_use_id: str
    claude_session_id: str | None = None
    tool: Literal["Edit", "Write", "MultiEdit"]
    path: str
    diff: str
    added_lines: int = 0
    removed_lines: int = 0
    timestamp: str
```

If `hive-agent/hive_agent/protocol.py` also has a discriminated union locally, add `DiffEventFrame` there too. Search for its presence:

```bash
grep -n "AgentFrame = " hive-agent/hive_agent/protocol.py
```

If found, mirror the union.

- [ ] **Step 6: Add `DiffEvent` API model to `hub/models/schemas.py`**

In `hub/models/schemas.py`, after the existing `NamedSession` block, add:

```python
class DiffEvent(BaseModel):
    """M27 — a single recorded Edit/Write/MultiEdit tool call in the
    diff_events table.

    Returned by ``GET /api/containers/{id}/diff-events`` and pushed on
    the ``diff-events:<container_id>`` WebSocket channel as the ``data``
    payload of ``event="new"`` frames.
    """

    event_id: str
    container_id: int
    claude_session_id: str | None
    tool_use_id: str
    tool: Literal["Edit", "Write", "MultiEdit"]
    path: str
    diff: str
    added_lines: int
    removed_lines: int
    size_bytes: int
    timestamp: str
    created_at: str
```

- [ ] **Step 7: Run the parity test and confirm it passes**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_agent_protocol.py::test_diff_event_frame_parity_hub_and_agent -v
```

Expected: PASS.

- [ ] **Step 8: Run the broader test suites to confirm no regressions**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests -q
cd /home/gnava/repos/honeycomb/hive-agent && uv run pytest tests -q
```

Both green.

- [ ] **Step 9: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/models/agent_protocol.py \
        hub/models/schemas.py \
        hive-agent/hive_agent/protocol.py \
        hub/tests/test_agent_protocol.py
git commit -m "feat(m27): DiffEventFrame wire protocol + DiffEvent API model

Adds the new agent→hub frame type for Edit/Write/MultiEdit tool
calls; mirrors it byte-compatibly into the hive-agent package; adds
the DiffEvent API model the hub uses for REST + WS payloads."
```

---

## Task 3: Service — `record_event` + `list_events` + auto-eviction

**Files:**

- Create: `hub/services/diff_events.py`
- Test: `hub/tests/test_diff_events_service.py`

- [ ] **Step 1: Write the failing service tests**

Create `hub/tests/test_diff_events_service.py`:

```python
"""Unit tests for the diff_events service layer (M27)."""

from __future__ import annotations

from pathlib import Path

import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine

from hub.db.migrations_runner import apply_migrations_sync
from hub.models.agent_protocol import DiffEventFrame
from hub.services.diff_events import list_events, record_event


@pytest_asyncio.fixture
async def engine(tmp_path: Path):
    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
    eng = create_async_engine(f"sqlite+aiosqlite:///{db_path}")

    @sa.event.listens_for(eng.sync_engine, "connect")
    def _fk_on(conn, _r):
        conn.execute("PRAGMA foreign_keys=ON")

    async with eng.begin() as conn:
        await conn.execute(
            sa.text(
                "INSERT INTO containers "
                "(workspace_folder, project_type, project_name, "
                "project_description, container_status, agent_status, "
                "agent_port, has_gpu, has_claude_cli, agent_expected, "
                "created_at, updated_at) "
                "VALUES ('/w','base','demo','','running','idle',0,0,0,1,"
                "'2026-04-20T00:00:00','2026-04-20T00:00:00')",
            ),
        )

    yield eng
    await eng.dispose()


def _frame(path: str = "/workspace/x.py", added: int = 1, removed: int = 0) -> DiffEventFrame:
    return DiffEventFrame(
        container_id="c-1",
        tool_use_id="toolu_test",
        claude_session_id=None,
        tool="Edit",
        path=path,
        diff="--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
        added_lines=added,
        removed_lines=removed,
        timestamp="2026-04-23T07:38:00Z",
    )


@pytest.mark.asyncio
async def test_record_event_returns_populated_row(engine) -> None:
    event = await record_event(engine, container_id=1, frame=_frame())
    assert len(event.event_id) == 32  # uuid4().hex
    assert event.container_id == 1
    assert event.tool == "Edit"
    assert event.path == "/workspace/x.py"
    assert event.added_lines == 1
    assert event.size_bytes > 0


@pytest.mark.asyncio
async def test_list_events_empty_by_default(engine) -> None:
    assert await list_events(engine, container_id=1) == []


@pytest.mark.asyncio
async def test_list_events_newest_first(engine) -> None:
    a = await record_event(engine, container_id=1, frame=_frame(path="/a"))
    b = await record_event(engine, container_id=1, frame=_frame(path="/b"))
    c = await record_event(engine, container_id=1, frame=_frame(path="/c"))
    events = await list_events(engine, container_id=1)
    assert [e.event_id for e in events] == [c.event_id, b.event_id, a.event_id]


@pytest.mark.asyncio
async def test_record_event_evicts_oldest_beyond_200(engine) -> None:
    """Insert 205 events; only the 200 most recent survive."""
    for i in range(205):
        await record_event(engine, container_id=1, frame=_frame(path=f"/p{i}"))
    events = await list_events(engine, container_id=1)
    assert len(events) == 200
    # Newest 200 are paths /p4 through /p204; oldest 5 (/p0../p4) evicted.
    paths = {e.path for e in events}
    for i in range(5):
        assert f"/p{i}" not in paths
    for i in range(5, 205):
        assert f"/p{i}" in paths


@pytest.mark.asyncio
async def test_cascade_on_container_delete(engine) -> None:
    await record_event(engine, container_id=1, frame=_frame())
    async with engine.begin() as conn:
        await conn.execute(sa.text("DELETE FROM containers WHERE id = 1"))
    assert await list_events(engine, container_id=1) == []
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_diff_events_service.py -v
```

Expected: FAIL — `ModuleNotFoundError: hub.services.diff_events`.

- [ ] **Step 3: Implement the service**

Create `hub/services/diff_events.py`:

```python
"""Persistent diff-event CRUD (M27).

Records each Claude Edit/Write/MultiEdit tool call as one row in the
``diff_events`` table. Per-container 200-event cap is enforced at
insert time — old rows are deleted in the same transaction so the
table stays bounded without a separate sweep.

Sole writer is :func:`record_event`, called from the agent WS
dispatcher in :mod:`hub.routers.agent`. Sole reader is
:func:`list_events`, called from :mod:`hub.routers.diff_events`
(REST) and the broadcast helper.
"""

from __future__ import annotations

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from hub.models.agent_protocol import DiffEventFrame
from hub.models.schemas import DiffEvent

DIFF_EVENT_CAP_PER_CONTAINER = 200


def _row_to_model(row) -> DiffEvent:
    return DiffEvent(
        event_id=row["event_id"],
        container_id=row["container_id"],
        claude_session_id=row["claude_session_id"],
        tool_use_id=row["tool_use_id"],
        tool=row["tool"],
        path=row["path"],
        diff=row["diff"],
        added_lines=row["added_lines"],
        removed_lines=row["removed_lines"],
        size_bytes=row["size_bytes"],
        timestamp=row["timestamp"],
        created_at=row["created_at"],
    )


async def record_event(
    engine: AsyncEngine,
    *,
    container_id: int,
    frame: DiffEventFrame,
) -> DiffEvent:
    """Insert a new diff event for ``container_id`` and prune oldest
    rows beyond the per-container cap. Returns the populated row."""
    event_id = uuid.uuid4().hex
    created_at = datetime.now().isoformat()
    size_bytes = len(frame.diff.encode("utf-8"))

    async with engine.begin() as conn:
        await conn.execute(
            sa.text(
                "INSERT INTO diff_events "
                "(event_id, container_id, claude_session_id, tool_use_id, "
                " tool, path, diff, added_lines, removed_lines, size_bytes, "
                " timestamp, created_at) "
                "VALUES (:eid, :cid, :csid, :tuid, :tool, :path, :diff, "
                "        :added, :removed, :size, :ts, :ca)"
            ),
            {
                "eid": event_id,
                "cid": container_id,
                "csid": frame.claude_session_id,
                "tuid": frame.tool_use_id,
                "tool": frame.tool,
                "path": frame.path,
                "diff": frame.diff,
                "added": frame.added_lines,
                "removed": frame.removed_lines,
                "size": size_bytes,
                "ts": frame.timestamp,
                "ca": created_at,
            },
        )
        await conn.execute(
            sa.text(
                "DELETE FROM diff_events "
                "WHERE container_id = :cid "
                "  AND id NOT IN ("
                "    SELECT id FROM diff_events "
                "    WHERE container_id = :cid "
                "    ORDER BY id DESC LIMIT :cap"
                "  )"
            ),
            {"cid": container_id, "cap": DIFF_EVENT_CAP_PER_CONTAINER},
        )
        row = (
            (
                await conn.execute(
                    sa.text(
                        "SELECT event_id, container_id, claude_session_id, "
                        "       tool_use_id, tool, path, diff, added_lines, "
                        "       removed_lines, size_bytes, timestamp, created_at "
                        "FROM diff_events WHERE event_id = :eid"
                    ),
                    {"eid": event_id},
                )
            )
            .mappings()
            .one()
        )
    return _row_to_model(row)


async def list_events(
    engine: AsyncEngine,
    *,
    container_id: int,
    limit: int = DIFF_EVENT_CAP_PER_CONTAINER,
) -> list[DiffEvent]:
    """Return diff events for a container, newest first, capped at ``limit``."""
    async with engine.connect() as conn:
        rows = (
            (
                await conn.execute(
                    sa.text(
                        "SELECT event_id, container_id, claude_session_id, "
                        "       tool_use_id, tool, path, diff, added_lines, "
                        "       removed_lines, size_bytes, timestamp, created_at "
                        "FROM diff_events "
                        "WHERE container_id = :cid "
                        "ORDER BY id DESC LIMIT :limit"
                    ),
                    {"cid": container_id, "limit": limit},
                )
            )
            .mappings()
            .all()
        )
    return [_row_to_model(r) for r in rows]
```

- [ ] **Step 4: Run the service tests and confirm they pass**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_diff_events_service.py -v
```

Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/diff_events.py hub/tests/test_diff_events_service.py
git commit -m "feat(m27): diff_events service — record + list + auto-eviction

Service-layer CRUD for the diff_events table. record_event inserts
a new row and prunes oldest rows beyond the 200/container cap in
one transaction so callers don't have to manage retention. list_events
is newest-first via the (container_id, created_at DESC) index."
```

---

## Task 4: Router — `GET /api/containers/{record_id}/diff-events`

**Files:**

- Create: `hub/routers/diff_events.py`
- Modify: `hub/main.py` (register the router)
- Test: `hub/tests/test_diff_events_endpoint.py`

- [ ] **Step 1: Write the failing endpoint tests**

Create `hub/tests/test_diff_events_endpoint.py`:

```python
"""Integration tests for the diff_events GET endpoint (M27)."""

from __future__ import annotations

from pathlib import Path

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings
from hub.db.migrations_runner import apply_migrations_sync
from hub.models.agent_protocol import DiffEventFrame
from hub.services.diff_events import record_event


@pytest_asyncio.fixture
async def client(tmp_path: Path):
    from hub.main import app
    from hub.services.registry import Registry

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
    sync_engine = sa.create_engine(f"sqlite:///{db_path}")
    with sync_engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO containers "
                "(workspace_folder, project_type, project_name, "
                "project_description, container_status, agent_status, "
                "agent_port, has_gpu, has_claude_cli, agent_expected, "
                "created_at, updated_at) "
                "VALUES ('/w','base','demo','','running','idle',0,0,0,1,"
                "'2026-04-20T00:00:00','2026-04-20T00:00:00')",
            ),
        )

    reg = Registry(db_path=db_path)
    await reg.open()

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.registry = reg

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c, reg

    await reg.close()


AUTH = {"Authorization": "Bearer test-token"}


def _frame(path: str = "/workspace/x.py") -> DiffEventFrame:
    return DiffEventFrame(
        container_id="c-1",
        tool_use_id="toolu_test",
        tool="Edit",
        path=path,
        diff="--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
        added_lines=1,
        removed_lines=1,
        timestamp="2026-04-23T07:38:00Z",
    )


@pytest.mark.asyncio
async def test_list_empty_container(client) -> None:
    c, _reg = client
    resp = await c.get("/api/containers/1/diff-events", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_returns_newest_first(client) -> None:
    c, reg = client
    a = await record_event(reg.engine, container_id=1, frame=_frame(path="/a"))
    b = await record_event(reg.engine, container_id=1, frame=_frame(path="/b"))

    resp = await c.get("/api/containers/1/diff-events", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert [r["event_id"] for r in body] == [b.event_id, a.event_id]
    assert body[0]["path"] == "/b"


@pytest.mark.asyncio
async def test_list_404_unknown_container(client) -> None:
    c, _reg = client
    resp = await c.get("/api/containers/999/diff-events", headers=AUTH)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_unauthorized() -> None:
    from hub.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.get("/api/containers/1/diff-events")
    assert resp.status_code == 401
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_diff_events_endpoint.py -v
```

Expected: FAIL — `404` on GET (route not registered).

- [ ] **Step 3: Create the router**

Create `hub/routers/diff_events.py`:

```python
"""Read-only router for the M27 Claude diff changelog.

Events arrive via the agent WebSocket, not REST — there is no POST
endpoint here. The dashboard reads via GET, then subscribes to the
``diff-events:<container_id>`` WS channel for live updates."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from hub.models.schemas import DiffEvent
from hub.services.diff_events import list_events

router = APIRouter(tags=["diff-events"])


async def _lookup_container_record(registry, record_id: int) -> None:
    try:
        await registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container record {record_id} not found")


@router.get(
    "/api/containers/{record_id}/diff-events",
    response_model=list[DiffEvent],
)
async def list_diff_events(record_id: int, request: Request) -> list[DiffEvent]:
    """Return the last 200 diff events for ``record_id``, newest first."""
    registry = request.app.state.registry
    await _lookup_container_record(registry, record_id)
    return await list_events(registry.engine, container_id=record_id)
```

- [ ] **Step 4: Register the router in `hub/main.py`**

Find the existing `app.include_router(...)` block (search for `app.include_router(named_sessions.router)`) and add a sibling line:

```python
from hub.routers import diff_events as diff_events_router
# ... in the lifespan or app setup section, alongside other include_router calls:
app.include_router(diff_events_router.router)
```

- [ ] **Step 5: Run the endpoint tests and confirm they pass**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_diff_events_endpoint.py -v
```

Expected: 4/4 PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/routers/diff_events.py hub/main.py hub/tests/test_diff_events_endpoint.py
git commit -m "feat(m27): GET /api/containers/{id}/diff-events router

Read-only — events flow IN via the agent WS, not REST. This endpoint
just exposes the table to the dashboard for the initial fetch + the
30s poll fallback."
```

---

## Task 5: Hub agent.py — DiffEventFrame dispatch + broadcast helper

**Files:**

- Modify: `hub/routers/agent.py` — add `isinstance(frame, DiffEventFrame)` branch + `_broadcast_diff_event` helper.
- Test: `hub/tests/test_agent_diff_event_intake.py`.

- [ ] **Step 1: Write the failing intake test**

Create `hub/tests/test_agent_diff_event_intake.py`:

```python
"""Tests for the agent-WS DiffEventFrame intake (M27).

Mocks the module-level ``ws_router.manager`` (the ConnectionManager
singleton broadcasts go through) using the same monkeypatch pattern
M30 introduced for sessions. Asserts the frame is recorded AND
broadcast on ``diff-events:<container_id>``."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
import sqlalchemy as sa

from hub.db.migrations_runner import apply_migrations_sync
from hub.models.agent_protocol import DiffEventFrame
from hub.services.diff_events import list_events


@pytest_asyncio.fixture
async def setup(tmp_path: Path, monkeypatch):
    from hub.routers import agent as agent_router
    from hub.services.registry import Registry

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
    sync = sa.create_engine(f"sqlite:///{db_path}")
    with sync.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO containers "
                "(id, workspace_folder, project_type, project_name, "
                "project_description, container_status, agent_status, "
                "agent_port, has_gpu, has_claude_cli, agent_expected, "
                "created_at, updated_at) "
                "VALUES (42, '/w','base','demo','','running','idle',0,0,0,1,"
                "'2026-04-20T00:00:00','2026-04-20T00:00:00')",
            ),
        )

    reg = Registry(db_path=db_path)
    await reg.open()

    # Mock the module-level WS manager so we can assert on broadcast.
    mock_mgr = MagicMock()
    mock_mgr.broadcast = AsyncMock()
    monkeypatch.setattr(agent_router.ws_router, "manager", mock_mgr)

    yield reg, mock_mgr, agent_router
    await reg.close()


@pytest.mark.asyncio
async def test_diff_event_frame_records_and_broadcasts(setup) -> None:
    reg, mock_mgr, agent_router = setup
    frame = DiffEventFrame(
        container_id="c-42",
        tool_use_id="toolu_1",
        tool="Edit",
        path="/workspace/foo.py",
        diff="--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
        added_lines=1,
        removed_lines=1,
        timestamp="2026-04-23T07:38:00Z",
    )

    # Direct-invoke the helper to keep the test focused on the
    # service+broadcast contract rather than the full WS handshake.
    await agent_router._broadcast_diff_event(reg.engine, container_id=42, frame=frame)

    rows = await list_events(reg.engine, container_id=42)
    assert len(rows) == 1
    assert rows[0].path == "/workspace/foo.py"

    assert mock_mgr.broadcast.await_count == 1
    sent = mock_mgr.broadcast.await_args.args[0]
    assert sent.channel == "diff-events:42"
    assert sent.event == "new"
    assert sent.data["path"] == "/workspace/foo.py"
    assert sent.data["event_id"] == rows[0].event_id


@pytest.mark.asyncio
async def test_broadcast_failure_does_not_raise(setup) -> None:
    reg, mock_mgr, agent_router = setup
    mock_mgr.broadcast.side_effect = RuntimeError("ws boom")

    frame = DiffEventFrame(
        container_id="c-42",
        tool_use_id="toolu_2",
        tool="Write",
        path="/workspace/bar.py",
        diff="+++ b/bar.py\n",
        added_lines=1,
        removed_lines=0,
        timestamp="2026-04-23T07:38:01Z",
    )

    # Helper must catch + log; the row still lands.
    await agent_router._broadcast_diff_event(reg.engine, container_id=42, frame=frame)
    rows = await list_events(reg.engine, container_id=42)
    assert len(rows) == 1
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_agent_diff_event_intake.py -v
```

Expected: FAIL — `AttributeError: module 'hub.routers.agent' has no attribute '_broadcast_diff_event'`.

- [ ] **Step 3: Add the helper + the dispatch case in `hub/routers/agent.py`**

In `hub/routers/agent.py`, after the existing imports add:

```python
from hub.models.agent_protocol import (
    AckFrame,
    DiffEventFrame,
    DoneFrame,
    HeartbeatFrame,
    HelloFrame,
    OutputFrame,
    parse_frame,
)
from hub.services.diff_events import record_event as _record_diff_event
```

(The `DiffEventFrame` import joins the existing list; `_record_diff_event` is the import alias to avoid collision with any local symbol.)

Add the broadcast helper near the top of the module (after `logger = logging.getLogger(...)` and before `router = APIRouter(...)`):

```python
async def _broadcast_diff_event(engine, *, container_id: int, frame: DiffEventFrame) -> None:
    """Insert the diff event row, then broadcast it on the
    ``diff-events:<container_id>`` channel. Broadcast failures are
    logged + swallowed so a WS hiccup never breaks the persistent
    write — same pattern as M30's ``_broadcast_sessions_list``."""
    event = await _record_diff_event(engine, container_id=container_id, frame=frame)
    try:
        wf = WSFrame(
            channel=f"diff-events:{container_id}",
            event="new",
            data=event.model_dump(mode="json"),
        )
        await ws_router.manager.broadcast(wf)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "diff_event_broadcast_failed",
            extra={"event_id": event.event_id, "error": str(exc)[:400]},
        )
```

In the dispatch loop (the chain of `if isinstance(frame, …)` branches), add a new case alongside the others (placement: after `OutputFrame`, before `DoneFrame`):

```python
            if isinstance(frame, DiffEventFrame):
                # The URL-derived container_id is the agent's self-declared
                # string identity (hostname / docker hash). The diff_events
                # FK and the WS channel both need the registry's integer
                # primary key, so look up the row first.
                record = await registry.get_by_container_id(container_id)
                if record is None:
                    logger.warning(
                        "diff_event_unknown_container",
                        extra={"container_id": container_id},
                    )
                    continue
                await _broadcast_diff_event(
                    registry.engine, container_id=record.id, frame=frame
                )
                continue
```

- [ ] **Step 4: Run the intake tests and confirm they pass**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_agent_diff_event_intake.py -v
```

Expected: 2/2 PASS.

- [ ] **Step 5: Run the full hub suite to confirm no regressions**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests -q
```

Expected: all green (existing 360 + new ones).

- [ ] **Step 6: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hub/routers/agent.py hub/tests/test_agent_diff_event_intake.py
git commit -m "feat(m27): agent-WS DiffEventFrame intake + broadcast

Routes incoming diff_event frames through record_event and
broadcasts on diff-events:<cid>. Broadcast failures are logged +
swallowed (same pattern as M30 _broadcast_sessions_list) so the
table write is independent of WS health."
```

---

## Task 6: hive-agent — `submit_diff()` forwarder on `HiveAgentWS`

**Files:**

- Modify: `hive-agent/hive_agent/ws_client.py` — add a `submit_diff(...)` async method that builds a `DiffEventFrame` and sends it on the live WS.
- Test: extend the existing ws_client test file (search `hive-agent/tests/` for one) or create `hive-agent/tests/test_submit_diff_forwarder.py`.

- [ ] **Step 1: Write the failing test**

Create `hive-agent/tests/test_submit_diff_forwarder.py`:

```python
"""Tests for HiveAgentWS.submit_diff (M27)."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest

from hive_agent.ws_client import HiveAgentWS


@pytest.mark.asyncio
async def test_submit_diff_sends_frame_on_live_ws() -> None:
    """submit_diff builds a DiffEventFrame and writes its JSON form
    to the active WebSocket connection."""
    client = HiveAgentWS(hub_url="http://h", container_id="c-7")
    fake_ws = AsyncMock()
    client._ws = fake_ws  # noqa: SLF001 — direct seam for unit test

    await client.submit_diff(
        tool="Edit",
        path="/workspace/foo.py",
        diff="--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
        tool_use_id="toolu_1",
        claude_session_id="sess",
        added_lines=1,
        removed_lines=1,
        timestamp="2026-04-23T07:38:00Z",
    )

    fake_ws.send.assert_awaited_once()
    payload = json.loads(fake_ws.send.await_args.args[0])
    assert payload["type"] == "diff_event"
    assert payload["container_id"] == "c-7"
    assert payload["tool"] == "Edit"
    assert payload["path"] == "/workspace/foo.py"
    assert payload["added_lines"] == 1


@pytest.mark.asyncio
async def test_submit_diff_no_active_ws_silently_drops() -> None:
    """If the WS isn't connected, submit_diff must not raise — the
    hook script that called us is not in a position to recover."""
    client = HiveAgentWS(hub_url="http://h", container_id="c-7")
    client._ws = None  # noqa: SLF001
    # Should not raise.
    await client.submit_diff(
        tool="Edit",
        path="/workspace/foo.py",
        diff="…",
        tool_use_id="toolu_1",
        timestamp="2026-04-23T07:38:00Z",
    )
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd /home/gnava/repos/honeycomb/hive-agent
uv run pytest tests/test_submit_diff_forwarder.py -v
```

Expected: FAIL — `AttributeError: 'HiveAgentWS' object has no attribute 'submit_diff'`.

- [ ] **Step 3: Add the method**

In `hive-agent/hive_agent/ws_client.py`, in the `HiveAgentWS` class (after the existing `_send` or alongside the heartbeat/ack/output/done senders), add:

```python
    async def submit_diff(
        self,
        *,
        tool: str,
        path: str,
        diff: str,
        tool_use_id: str,
        claude_session_id: str | None = None,
        added_lines: int = 0,
        removed_lines: int = 0,
        timestamp: str,
    ) -> None:
        """Send a DiffEventFrame to the hub (M27).

        Best-effort. If the WS isn't connected we log + drop —
        diff capture must never block the calling hook script."""
        from hive_agent.protocol import DiffEventFrame

        ws = self._ws
        if ws is None:
            self._logger.warning("submit_diff: no active websocket; dropping event")
            return
        frame = DiffEventFrame(
            container_id=self._container_id,
            tool=tool,  # type: ignore[arg-type]
            path=path,
            diff=diff,
            tool_use_id=tool_use_id,
            claude_session_id=claude_session_id,
            added_lines=added_lines,
            removed_lines=removed_lines,
            timestamp=timestamp,
        )
        try:
            await ws.send(frame.model_dump_json())
        except Exception as exc:  # noqa: BLE001
            self._logger.warning("submit_diff: send failed: %s", exc)
```

(If `self._logger` doesn't exist on `HiveAgentWS`, swap to the module-level `logger`. Inspect `ws_client.py` to confirm the conventional name.)

- [ ] **Step 4: Run the test and confirm it passes**

```bash
cd /home/gnava/repos/honeycomb/hive-agent
uv run pytest tests/test_submit_diff_forwarder.py -v
```

Expected: 2/2 PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hive-agent/hive_agent/ws_client.py hive-agent/tests/test_submit_diff_forwarder.py
git commit -m "feat(m27): HiveAgentWS.submit_diff forwarder

Pushes a DiffEventFrame over the live reverse-tunnel WS. Best-
effort: if the WS isn't connected (or send fails), logs a warning
and drops the event — diff capture must never block the hook."
```

---

## Task 7: hive-agent — `socket_listener` Unix socket coroutine

**Files:**

- Create: `hive-agent/hive_agent/socket_listener.py`.
- Modify: `hive-agent/hive_agent/ws_client.py` — wire the listener into the daemon's run loop.
- Test: `hive-agent/tests/test_socket_listener.py`.

- [ ] **Step 1: Write the failing listener test**

Create `hive-agent/tests/test_socket_listener.py`:

```python
"""Tests for the M27 Unix-socket listener."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from hive_agent.socket_listener import SocketListener


@pytest.mark.asyncio
async def test_listener_calls_submit_diff_on_jsonl(tmp_path: Path) -> None:
    sock_path = tmp_path / "agent.sock"
    submit_diff = AsyncMock()
    listener = SocketListener(socket_path=sock_path, submit_diff=submit_diff)

    server_task = asyncio.create_task(listener.serve())
    # Wait for the socket file to appear.
    for _ in range(50):
        if sock_path.exists():
            break
        await asyncio.sleep(0.01)
    assert sock_path.exists()

    # Connect as a client and send one JSON line.
    reader, writer = await asyncio.open_unix_connection(str(sock_path))
    payload = {
        "tool": "Edit",
        "path": "/workspace/foo.py",
        "diff": "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
        "tool_use_id": "toolu_1",
        "claude_session_id": "sess",
        "added_lines": 1,
        "removed_lines": 1,
        "timestamp": "2026-04-23T07:38:00Z",
    }
    writer.write((json.dumps(payload) + "\n").encode("utf-8"))
    await writer.drain()
    writer.close()
    await writer.wait_closed()

    # Allow the server time to dispatch.
    for _ in range(50):
        if submit_diff.await_count >= 1:
            break
        await asyncio.sleep(0.02)

    listener.stop()
    await asyncio.wait_for(server_task, timeout=2.0)

    assert submit_diff.await_count == 1
    kwargs = submit_diff.await_args.kwargs
    assert kwargs["tool"] == "Edit"
    assert kwargs["path"] == "/workspace/foo.py"


@pytest.mark.asyncio
async def test_listener_socket_file_perms(tmp_path: Path) -> None:
    """The socket file must be created mode 0660 so that only the
    Claude-running user can write to it."""
    sock_path = tmp_path / "agent.sock"
    submit_diff = AsyncMock()
    listener = SocketListener(socket_path=sock_path, submit_diff=submit_diff)
    server_task = asyncio.create_task(listener.serve())
    for _ in range(50):
        if sock_path.exists():
            break
        await asyncio.sleep(0.01)
    mode = os.stat(sock_path).st_mode & 0o777
    assert mode == 0o660
    listener.stop()
    await asyncio.wait_for(server_task, timeout=2.0)
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd /home/gnava/repos/honeycomb/hive-agent
uv run pytest tests/test_socket_listener.py -v
```

Expected: FAIL — `ModuleNotFoundError: hive_agent.socket_listener`.

- [ ] **Step 3: Implement the listener**

Create `hive-agent/hive_agent/socket_listener.py`:

```python
"""Unix-socket listener for the M27 diff_event submission path.

Runs alongside the main WS loop. Hook scripts (or the
``hive-agent submit-diff`` CLI) connect to this socket and write a
single JSON line per event; we parse and forward to the hub via
``submit_diff``.

Frame on the socket is one JSON object per line:

    {"tool": "Edit", "path": "/...", "diff": "...",
     "tool_use_id": "...", "claude_session_id": "..." | null,
     "added_lines": int, "removed_lines": int,
     "timestamp": "..."}

Anything malformed is logged and dropped — the calling hook is not
in a position to recover.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


SubmitDiff = Callable[..., Awaitable[None]]


class SocketListener:
    """Async Unix-socket server that forwards JSON-line submissions
    to the supplied ``submit_diff`` coroutine."""

    def __init__(self, *, socket_path: Path, submit_diff: SubmitDiff) -> None:
        self._socket_path = Path(socket_path)
        self._submit_diff = submit_diff
        self._server: asyncio.AbstractServer | None = None
        self._stop_event = asyncio.Event()

    async def serve(self) -> None:
        # Remove stale socket file so re-running the daemon doesn't
        # fail with EADDRINUSE.
        if self._socket_path.exists():
            self._socket_path.unlink()
        self._socket_path.parent.mkdir(parents=True, exist_ok=True)

        self._server = await asyncio.start_unix_server(
            self._handle_client, path=str(self._socket_path)
        )
        os.chmod(self._socket_path, 0o660)

        logger.info("socket_listener_started: %s", self._socket_path)
        try:
            await self._stop_event.wait()
        finally:
            self._server.close()
            await self._server.wait_closed()
            with self._silence_oserror():
                self._socket_path.unlink()

    def stop(self) -> None:
        self._stop_event.set()

    @staticmethod
    def _silence_oserror():
        from contextlib import suppress

        return suppress(OSError, FileNotFoundError)

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            while True:
                raw = await reader.readline()
                if not raw:
                    return
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError as exc:
                    logger.warning("socket_listener_bad_json: %s", exc)
                    continue
                if not isinstance(payload, dict):
                    logger.warning("socket_listener_non_object_payload")
                    continue
                await self._dispatch(payload)
        finally:
            writer.close()
            await writer.wait_closed()

    async def _dispatch(self, payload: dict[str, Any]) -> None:
        try:
            await self._submit_diff(
                tool=payload["tool"],
                path=payload["path"],
                diff=payload["diff"],
                tool_use_id=payload["tool_use_id"],
                claude_session_id=payload.get("claude_session_id"),
                added_lines=int(payload.get("added_lines", 0)),
                removed_lines=int(payload.get("removed_lines", 0)),
                timestamp=payload["timestamp"],
            )
        except KeyError as exc:
            logger.warning("socket_listener_missing_field: %s", exc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("socket_listener_dispatch_failed: %s", exc)
```

- [ ] **Step 4: Wire it into the daemon's run loop**

In `hive-agent/hive_agent/ws_client.py`, locate the `start()` method and the run-loop coroutines. Add a constant for the socket path near the top of the file:

```python
DEFAULT_SOCKET_PATH = "/run/honeycomb/agent.sock"
```

In `HiveAgentWS.__init__`, accept an optional socket path:

```python
def __init__(
    self,
    *,
    hub_url: str | None = None,
    container_id: str | None = None,
    heartbeat_interval: float = 5.0,
    socket_path: str | None = None,
) -> None:
    # ... existing init ...
    self._socket_path = socket_path or os.environ.get(
        "HIVE_AGENT_SOCKET", DEFAULT_SOCKET_PATH
    )
    self._socket_listener = None
```

In the start method (or wherever existing background tasks like the heartbeat get spawned), add:

```python
        from hive_agent.socket_listener import SocketListener
        from pathlib import Path

        self._socket_listener = SocketListener(
            socket_path=Path(self._socket_path),
            submit_diff=self.submit_diff,
        )
        self._socket_listener_task = asyncio.create_task(self._socket_listener.serve())
```

In the stop / cleanup path, add:

```python
        if self._socket_listener is not None:
            self._socket_listener.stop()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(self._socket_listener_task, timeout=2.0)
```

- [ ] **Step 5: Run the listener tests and confirm they pass**

```bash
cd /home/gnava/repos/honeycomb/hive-agent
uv run pytest tests/test_socket_listener.py -v
```

Expected: 2/2 PASS.

- [ ] **Step 6: Run the full hive-agent suite**

```bash
cd /home/gnava/repos/honeycomb/hive-agent
uv run pytest tests -q
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hive-agent/hive_agent/socket_listener.py \
        hive-agent/hive_agent/ws_client.py \
        hive-agent/tests/test_socket_listener.py
git commit -m "feat(m27): hive-agent socket_listener forwards diff events

New Unix-socket listener at /run/honeycomb/agent.sock (mode 0660)
runs alongside the main WS loop. Hook scripts write one JSON line
per event; the listener dispatches via HiveAgentWS.submit_diff."
```

---

## Task 8: hive-agent CLI — `submit-diff` subcommand

**Files:**

- Modify: `hive-agent/hive_agent/cli.py` — add the `submit-diff` `click` subcommand.
- Test: `hive-agent/tests/test_submit_diff_cli.py`.

- [ ] **Step 1: Write the failing CLI test**

Create `hive-agent/tests/test_submit_diff_cli.py`:

```python
"""Tests for `hive-agent submit-diff`."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest
from click.testing import CliRunner

from hive_agent.cli import main


@pytest.mark.asyncio
async def test_submit_diff_writes_jsonl_to_socket(tmp_path: Path) -> None:
    sock_path = tmp_path / "agent.sock"

    received: list[dict] = []

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        line = await reader.readline()
        received.append(json.loads(line.decode()))
        writer.close()

    server = await asyncio.start_unix_server(handler, path=str(sock_path))
    os.chmod(sock_path, 0o660)
    serve_task = asyncio.create_task(server.serve_forever())

    runner = CliRunner()
    diff_text = "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n"
    # CLI runs synchronously; let it block the asyncio loop briefly.
    result = await asyncio.to_thread(
        runner.invoke,
        main,
        [
            "submit-diff",
            "--tool",
            "Edit",
            "--path",
            "/workspace/foo.py",
            "--tool-use-id",
            "toolu_1",
            "--added-lines",
            "1",
            "--removed-lines",
            "1",
            "--timestamp",
            "2026-04-23T07:38:00Z",
            "--socket",
            str(sock_path),
            "--diff",
            "-",
        ],
        input=diff_text,
    )
    assert result.exit_code == 0, result.output

    server.close()
    await server.wait_closed()
    serve_task.cancel()
    try:
        await serve_task
    except asyncio.CancelledError:
        pass

    assert len(received) == 1
    assert received[0]["tool"] == "Edit"
    assert received[0]["path"] == "/workspace/foo.py"
    assert received[0]["diff"] == diff_text
    assert received[0]["added_lines"] == 1


def test_submit_diff_missing_socket_exits_nonzero(tmp_path: Path) -> None:
    runner = CliRunner()
    result = runner.invoke(
        main,
        [
            "submit-diff",
            "--tool",
            "Edit",
            "--path",
            "/x",
            "--tool-use-id",
            "t1",
            "--timestamp",
            "2026-04-23T07:38:00Z",
            "--socket",
            str(tmp_path / "does-not-exist.sock"),
            "--diff",
            "-",
        ],
        input="empty",
    )
    assert result.exit_code != 0
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd /home/gnava/repos/honeycomb/hive-agent
uv run pytest tests/test_submit_diff_cli.py -v
```

Expected: FAIL — `Error: No such command 'submit-diff'`.

- [ ] **Step 3: Add the subcommand to `hive-agent/hive_agent/cli.py`**

In `hive-agent/hive_agent/cli.py`, after the existing `start` command, add:

```python
@main.command("submit-diff")
@click.option("--tool", required=True, type=click.Choice(["Edit", "Write", "MultiEdit"]))
@click.option("--path", required=True)
@click.option("--tool-use-id", required=True)
@click.option("--claude-session-id", default=None)
@click.option("--added-lines", default=0, type=int)
@click.option("--removed-lines", default=0, type=int)
@click.option("--timestamp", required=True)
@click.option(
    "--diff",
    required=True,
    help="Unified diff. Pass `-` to read from stdin or `@<path>` to read from a file.",
)
@click.option(
    "--socket",
    "socket_path",
    default="/run/honeycomb/agent.sock",
    help="Unix socket the hive-agent daemon listens on.",
)
def submit_diff_cmd(
    tool: str,
    path: str,
    tool_use_id: str,
    claude_session_id: str | None,
    added_lines: int,
    removed_lines: int,
    timestamp: str,
    diff: str,
    socket_path: str,
) -> None:
    """Submit a Claude tool-call diff to the hub via the local agent."""
    import json
    import socket as _socket
    import sys

    if diff == "-":
        diff_text = sys.stdin.read()
    elif diff.startswith("@"):
        with open(diff[1:], encoding="utf-8") as f:
            diff_text = f.read()
    else:
        diff_text = diff

    payload = {
        "tool": tool,
        "path": path,
        "tool_use_id": tool_use_id,
        "claude_session_id": claude_session_id,
        "added_lines": added_lines,
        "removed_lines": removed_lines,
        "timestamp": timestamp,
        "diff": diff_text,
    }
    line = json.dumps(payload) + "\n"

    s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
    try:
        s.connect(socket_path)
        s.sendall(line.encode("utf-8"))
    except OSError as exc:
        click.echo(f"submit-diff: failed to talk to {socket_path}: {exc}", err=True)
        sys.exit(1)
    finally:
        s.close()
```

- [ ] **Step 4: Run the CLI tests and confirm they pass**

```bash
cd /home/gnava/repos/honeycomb/hive-agent
uv run pytest tests/test_submit_diff_cli.py -v
```

Expected: 2/2 PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add hive-agent/hive_agent/cli.py hive-agent/tests/test_submit_diff_cli.py
git commit -m "feat(m27): hive-agent submit-diff subcommand

CLI shim that hook scripts use to forward diffs to the local
agent's Unix socket. Reads the diff from stdin / file / arg,
exits non-zero on socket connect failure (caller swallows)."
```

---

## Task 9: Bootstrapper — `diff-pre` + `diff-post` hook scripts + tests

**Files:**

- Create: `bootstrapper/claude-hive-feature/hooks/diff-pre` (mode 0755).
- Create: `bootstrapper/claude-hive-feature/hooks/diff-post` (mode 0755).
- Create: `bootstrapper/tests/test_hooks_diff.py`.

- [ ] **Step 1: Write the failing harness tests**

Create `bootstrapper/tests/test_hooks_diff.py`:

```python
"""Hook-script tests for the M27 diff_event capture path."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
HOOKS_DIR = REPO_ROOT / "bootstrapper" / "claude-hive-feature" / "hooks"
DIFF_PRE = HOOKS_DIR / "diff-pre"
DIFF_POST = HOOKS_DIR / "diff-post"


def _run_hook(
    script: Path,
    payload: dict,
    *,
    staging_dir: Path,
    hive_agent: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["HIVE_DIFF_STAGING"] = str(staging_dir)
    if hive_agent is not None:
        env["HIVE_AGENT_BIN"] = str(hive_agent)
    return subprocess.run(
        ["python3", str(script)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
    )


@pytest.fixture
def staging(tmp_path: Path) -> Path:
    s = tmp_path / "staging"
    s.mkdir()
    return s


@pytest.fixture
def fake_hive_agent(tmp_path: Path) -> Path:
    """A shim that records its argv + stdin to a JSON file so the
    test can assert on what the hook would have shipped."""
    log_file = tmp_path / "hive_agent_calls.log"
    script = tmp_path / "hive-agent"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "with open(os.environ['HIVE_AGENT_LOG'], 'a') as f:\n"
        "    f.write(json.dumps({'argv': sys.argv[1:], 'stdin': sys.stdin.read()}) + '\\n')\n"
        "sys.exit(0)\n"
    )
    script.chmod(0o755)
    os.environ["HIVE_AGENT_LOG"] = str(log_file)
    return script


def _calls(log_file: Path) -> list[dict]:
    if not log_file.exists():
        return []
    return [json.loads(line) for line in log_file.read_text().splitlines() if line.strip()]


def test_diff_pre_snapshots_existing_file(staging: Path, tmp_path: Path) -> None:
    target = tmp_path / "foo.py"
    target.write_text("hello\n")
    payload = {
        "tool_name": "Edit",
        "tool_use_id": "toolu_1",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    result = _run_hook(DIFF_PRE, payload, staging_dir=staging)
    assert result.returncode == 0, result.stderr
    snapshot = staging / "toolu_1.before"
    assert snapshot.read_text() == "hello\n"


def test_diff_pre_no_file_no_snapshot(staging: Path, tmp_path: Path) -> None:
    payload = {
        "tool_name": "Write",
        "tool_use_id": "toolu_2",
        "tool_input": {"file_path": str(tmp_path / "absent.py")},
        "session_id": "sess",
    }
    result = _run_hook(DIFF_PRE, payload, staging_dir=staging)
    assert result.returncode == 0
    assert not (staging / "toolu_2.before").exists()


def test_diff_post_normal_edit(
    staging: Path, tmp_path: Path, fake_hive_agent: Path
) -> None:
    target = tmp_path / "foo.py"
    (staging / "toolu_3.before").write_text("a\nb\n")
    target.write_text("a\nB\n")
    payload = {
        "tool_name": "Edit",
        "tool_use_id": "toolu_3",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    log = tmp_path / "calls.log"
    os.environ["HIVE_AGENT_LOG"] = str(log)
    result = _run_hook(DIFF_POST, payload, staging_dir=staging, hive_agent=fake_hive_agent)
    assert result.returncode == 0, result.stderr
    calls = _calls(log)
    assert len(calls) == 1
    argv = calls[0]["argv"]
    assert "submit-diff" in argv
    assert "--tool" in argv and argv[argv.index("--tool") + 1] == "Edit"
    assert "--path" in argv and argv[argv.index("--path") + 1] == str(target)
    assert "-" in argv  # diff is read from stdin
    assert "--- " in calls[0]["stdin"] or "@@" in calls[0]["stdin"]
    # Pre-snapshot is cleaned up after submission.
    assert not (staging / "toolu_3.before").exists()


def test_diff_post_write_to_new_file_treated_as_insert(
    staging: Path, tmp_path: Path, fake_hive_agent: Path
) -> None:
    target = tmp_path / "new.py"
    target.write_text("brand\nnew\n")
    payload = {
        "tool_name": "Write",
        "tool_use_id": "toolu_4",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    log = tmp_path / "calls.log"
    os.environ["HIVE_AGENT_LOG"] = str(log)
    result = _run_hook(DIFF_POST, payload, staging_dir=staging, hive_agent=fake_hive_agent)
    assert result.returncode == 0
    calls = _calls(log)
    assert len(calls) == 1
    assert "+brand" in calls[0]["stdin"]


def test_diff_post_noop_skips_submit(
    staging: Path, tmp_path: Path, fake_hive_agent: Path
) -> None:
    target = tmp_path / "foo.py"
    target.write_text("same\n")
    (staging / "toolu_5.before").write_text("same\n")
    payload = {
        "tool_name": "Edit",
        "tool_use_id": "toolu_5",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    log = tmp_path / "calls.log"
    os.environ["HIVE_AGENT_LOG"] = str(log)
    result = _run_hook(DIFF_POST, payload, staging_dir=staging, hive_agent=fake_hive_agent)
    assert result.returncode == 0
    assert _calls(log) == []


def test_diff_post_binary_skipped(
    staging: Path, tmp_path: Path, fake_hive_agent: Path
) -> None:
    target = tmp_path / "blob.bin"
    target.write_bytes(b"\x00\x01\x02" + b"x" * 1024)
    (staging / "toolu_6.before").write_bytes(b"\x00\x01\x03" + b"x" * 1024)
    payload = {
        "tool_name": "Edit",
        "tool_use_id": "toolu_6",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    log = tmp_path / "calls.log"
    os.environ["HIVE_AGENT_LOG"] = str(log)
    result = _run_hook(DIFF_POST, payload, staging_dir=staging, hive_agent=fake_hive_agent)
    assert result.returncode == 0
    assert _calls(log) == []


def test_diff_post_oversize_marker(
    staging: Path, tmp_path: Path, fake_hive_agent: Path
) -> None:
    target = tmp_path / "big.txt"
    huge = "X" * (260 * 1024)
    (staging / "toolu_7.before").write_text("")
    target.write_text(huge)
    payload = {
        "tool_name": "Write",
        "tool_use_id": "toolu_7",
        "tool_input": {"file_path": str(target)},
        "session_id": "sess",
    }
    log = tmp_path / "calls.log"
    os.environ["HIVE_AGENT_LOG"] = str(log)
    result = _run_hook(DIFF_POST, payload, staging_dir=staging, hive_agent=fake_hive_agent)
    assert result.returncode == 0
    calls = _calls(log)
    assert len(calls) == 1
    assert "[diff exceeds 256 KiB cap; not stored]" in calls[0]["stdin"]
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /home/gnava/repos/honeycomb
uv run --project hub pytest bootstrapper/tests/test_hooks_diff.py -v
```

(Use the hub project to get a uv-managed Python — the bootstrapper has no separate venv. If pytest isn't on the hub's path, run via `python -m pytest` from the venv that does have it.)

Expected: FAIL — hook scripts don't exist yet.

- [ ] **Step 3: Implement `diff-pre`**

Create `bootstrapper/claude-hive-feature/hooks/diff-pre`:

```python
#!/usr/bin/env python3
"""M27 — Claude Code PreToolUse hook: snapshot the file about to
be edited so the matching diff-post hook can compute a diff.

Reads JSON from stdin (Claude Code's hook protocol). Snapshots the
target file (if it exists and is regular) into
``${HIVE_DIFF_STAGING}/${tool_use_id}.before``. Exits 0 unconditionally
— hook failures must never block a tool call.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:  # noqa: BLE001
        return 0  # malformed → silent

    tool_use_id = payload.get("tool_use_id")
    if not tool_use_id:
        return 0

    file_path = (payload.get("tool_input") or {}).get("file_path")
    if not file_path:
        return 0

    staging_dir = Path(os.environ.get("HIVE_DIFF_STAGING", "/run/honeycomb/staging"))
    try:
        staging_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(staging_dir, 0o700)
    except OSError:
        return 0

    src = Path(file_path)
    if not src.is_file():
        return 0

    dst = staging_dir / f"{tool_use_id}.before"
    try:
        shutil.copyfile(src, dst)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Implement `diff-post`**

Create `bootstrapper/claude-hive-feature/hooks/diff-post`:

```python
#!/usr/bin/env python3
"""M27 — Claude Code PostToolUse hook: compute a unified diff
between the pre-snapshot (if any) and the current file, and forward
to the hub via ``hive-agent submit-diff``.

Reads JSON from stdin. Skips silently on no-op / binary / missing
inputs. Caps diff at 256 KiB; oversize gets a marker payload.
"""

from __future__ import annotations

import difflib
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

DIFF_BYTE_CAP = 256 * 1024
OVERSIZE_MARKER = "[diff exceeds 256 KiB cap; not stored]"


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, IsADirectoryError, PermissionError):
        return ""
    except UnicodeDecodeError:
        return ""


def _looks_binary(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            chunk = f.read(8192)
    except OSError:
        return False
    return b"\x00" in chunk


def _count_changes(diff_text: str) -> tuple[int, int]:
    add = rem = 0
    for line in diff_text.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            add += 1
        elif line.startswith("-"):
            rem += 1
    return add, rem


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:  # noqa: BLE001
        return 0

    tool_use_id = payload.get("tool_use_id")
    tool_name = payload.get("tool_name")
    file_path = (payload.get("tool_input") or {}).get("file_path")
    if not (tool_use_id and tool_name and file_path):
        return 0
    if tool_name not in ("Edit", "Write", "MultiEdit"):
        return 0

    staging_dir = Path(os.environ.get("HIVE_DIFF_STAGING", "/run/honeycomb/staging"))
    pre_snapshot = staging_dir / f"{tool_use_id}.before"
    target = Path(file_path)

    # Binary check on either side — skip silently.
    if pre_snapshot.exists() and _looks_binary(pre_snapshot):
        _cleanup(pre_snapshot)
        return 0
    if target.exists() and _looks_binary(target):
        _cleanup(pre_snapshot)
        return 0

    before = _read_text(pre_snapshot) if pre_snapshot.exists() else ""
    after = _read_text(target) if target.exists() else ""

    diff_iter = difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile=f"a{file_path}",
        tofile=f"b{file_path}",
        lineterm="",
    )
    diff_text = "".join(diff_iter)
    if not diff_text:
        _cleanup(pre_snapshot)
        return 0

    added, removed = _count_changes(diff_text)
    if len(diff_text.encode("utf-8")) > DIFF_BYTE_CAP:
        diff_text = OVERSIZE_MARKER
        added = removed = 0

    timestamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    bin_path = os.environ.get("HIVE_AGENT_BIN", "hive-agent")
    try:
        subprocess.run(
            [
                bin_path,
                "submit-diff",
                "--tool",
                tool_name,
                "--path",
                file_path,
                "--tool-use-id",
                tool_use_id,
                "--claude-session-id",
                payload.get("session_id") or "",
                "--added-lines",
                str(added),
                "--removed-lines",
                str(removed),
                "--timestamp",
                timestamp,
                "--diff",
                "-",
            ],
            input=diff_text,
            text=True,
            check=False,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    _cleanup(pre_snapshot)
    return 0


def _cleanup(path: Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Make the hooks executable**

```bash
cd /home/gnava/repos/honeycomb
chmod +x bootstrapper/claude-hive-feature/hooks/diff-pre \
         bootstrapper/claude-hive-feature/hooks/diff-post
```

- [ ] **Step 6: Run the harness tests and confirm they pass**

```bash
cd /home/gnava/repos/honeycomb
uv run --project hub pytest bootstrapper/tests/test_hooks_diff.py -v
```

Expected: 7/7 PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add bootstrapper/claude-hive-feature/hooks/diff-pre \
        bootstrapper/claude-hive-feature/hooks/diff-post \
        bootstrapper/tests/test_hooks_diff.py
git commit -m "feat(m27): PreToolUse + PostToolUse hooks for Claude diffs

Pre-hook snapshots the target file by tool_use_id; post-hook
diffs and forwards via 'hive-agent submit-diff'. Binary, no-op,
and oversize cases are handled per the spec — silently skipped
or replaced with a marker. Hooks always exit 0 so a failure here
never breaks Claude's workflow."
```

---

## Task 10: Bootstrapper `install.sh` — install hooks + idempotent settings.json merge

**Files:**

- Modify: `bootstrapper/claude-hive-feature/install.sh`.
- Test: `bootstrapper/tests/test_hooks_install.py` (new).

- [ ] **Step 1: Write the install-merge test**

Create `bootstrapper/tests/test_hooks_install.py`:

```python
"""Tests for the install.sh hooks-block merge logic."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
INSTALL_SH = REPO / "bootstrapper" / "claude-hive-feature" / "install.sh"


def _run_merge(home: Path) -> subprocess.CompletedProcess[str]:
    """Invoke just the merge step. install.sh exposes a function we
    can call by sourcing it; for the test we mirror the merge with
    the same Python one-liner so we don't need a real container."""
    merger = REPO / "bootstrapper" / "claude-hive-feature" / "hooks" / "merge_settings.py"
    return subprocess.run(
        ["python3", str(merger), str(home / ".claude" / "settings.json")],
        capture_output=True,
        text=True,
    )


def test_merge_into_empty_home(tmp_path: Path) -> None:
    (tmp_path / ".claude").mkdir()
    result = _run_merge(tmp_path)
    assert result.returncode == 0, result.stderr

    settings = json.loads((tmp_path / ".claude" / "settings.json").read_text())
    pre = settings["hooks"]["PreToolUse"]
    post = settings["hooks"]["PostToolUse"]
    assert any("diff-pre" in h["hooks"][0]["command"] for h in pre)
    assert any("diff-post" in h["hooks"][0]["command"] for h in post)


def test_merge_preserves_existing_user_hooks(tmp_path: Path) -> None:
    settings_path = tmp_path / ".claude" / "settings.json"
    settings_path.parent.mkdir()
    settings_path.write_text(
        json.dumps(
            {
                "hooks": {
                    "PreToolUse": [
                        {
                            "matcher": "Bash",
                            "hooks": [{"type": "command", "command": "/usr/local/user-pre"}],
                        }
                    ]
                }
            }
        )
    )
    _run_merge(tmp_path)
    merged = json.loads(settings_path.read_text())
    pre = merged["hooks"]["PreToolUse"]
    matchers = [h.get("matcher") for h in pre]
    assert "Bash" in matchers
    assert "Edit|Write|MultiEdit" in matchers


def test_merge_is_idempotent(tmp_path: Path) -> None:
    (tmp_path / ".claude").mkdir()
    _run_merge(tmp_path)
    _run_merge(tmp_path)
    settings = json.loads((tmp_path / ".claude" / "settings.json").read_text())
    pre = settings["hooks"]["PreToolUse"]
    diff_pre_count = sum(
        1
        for h in pre
        if any("diff-pre" in c.get("command", "") for c in h.get("hooks", []))
    )
    assert diff_pre_count == 1
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /home/gnava/repos/honeycomb
uv run --project hub pytest bootstrapper/tests/test_hooks_install.py -v
```

Expected: FAIL — `merge_settings.py` doesn't exist.

- [ ] **Step 3: Add the merge helper**

Create `bootstrapper/claude-hive-feature/hooks/merge_settings.py`:

```python
#!/usr/bin/env python3
"""Idempotently merge the M27 hooks block into a user's
~/.claude/settings.json.

Adds an entry to ``hooks.PreToolUse`` and ``hooks.PostToolUse`` that
points at /usr/local/share/honeycomb/hooks/diff-{pre,post}. Existing
user hooks (other matchers, other commands) are preserved. If our
own entry is already present, the script is a no-op.

Usage:

    python3 merge_settings.py /path/to/settings.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

INSTALL_DIR = "/usr/local/share/honeycomb/hooks"
MATCHER = "Edit|Write|MultiEdit"


def _ensure_entry(items: list[dict], command: str) -> list[dict]:
    for entry in items:
        if entry.get("matcher") != MATCHER:
            continue
        for cmd in entry.get("hooks", []):
            if cmd.get("command") == command:
                return items
    items.append(
        {
            "matcher": MATCHER,
            "hooks": [{"type": "command", "command": command}],
        }
    )
    return items


def main(target: Path) -> int:
    settings: dict = {}
    if target.exists():
        try:
            settings = json.loads(target.read_text())
        except json.JSONDecodeError:
            settings = {}
    settings.setdefault("hooks", {})
    settings["hooks"].setdefault("PreToolUse", [])
    settings["hooks"].setdefault("PostToolUse", [])

    settings["hooks"]["PreToolUse"] = _ensure_entry(
        settings["hooks"]["PreToolUse"], f"{INSTALL_DIR}/diff-pre"
    )
    settings["hooks"]["PostToolUse"] = _ensure_entry(
        settings["hooks"]["PostToolUse"], f"{INSTALL_DIR}/diff-post"
    )

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(settings, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: merge_settings.py <path/to/settings.json>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1])))
```

- [ ] **Step 4: Add the install.sh block**

Append to `bootstrapper/claude-hive-feature/install.sh` (at the end of the script, before any final cleanup):

```bash
# --- M27: Claude diff-event hooks --------------------------------------------
HOOKS_DIR=/usr/local/share/honeycomb/hooks
if [ -d "$(dirname "$0")/hooks" ]; then
    log "Installing M27 diff-event hook scripts to ${HOOKS_DIR}"
    install -d -m 0755 "${HOOKS_DIR}"
    install -m 0755 "$(dirname "$0")/hooks/diff-pre" "${HOOKS_DIR}/diff-pre"
    install -m 0755 "$(dirname "$0")/hooks/diff-post" "${HOOKS_DIR}/diff-post"

    log "Merging hook entries into ~/.claude/settings.json"
    python3 "$(dirname "$0")/hooks/merge_settings.py" "${HOME}/.claude/settings.json"

    # Staging dir at /run/honeycomb/staging (mode 0700) for the
    # pre-hook's file snapshots.
    install -d -m 0700 /run/honeycomb/staging || true
fi
```

- [ ] **Step 5: Run the install tests and confirm they pass**

```bash
cd /home/gnava/repos/honeycomb
uv run --project hub pytest bootstrapper/tests/test_hooks_install.py -v
```

Expected: 3/3 PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add bootstrapper/claude-hive-feature/install.sh \
        bootstrapper/claude-hive-feature/hooks/merge_settings.py \
        bootstrapper/tests/test_hooks_install.py
git commit -m "feat(m27): install M27 hooks via claude-hive Feature

install.sh now copies the diff-pre/post hook scripts into
/usr/local/share/honeycomb/hooks and idempotently merges entries
into ~/.claude/settings.json. Existing user hooks are preserved;
re-running the install does not duplicate our entry."
```

---

## Task 11: Dashboard — types + API wrapper

**Files:**

- Modify: `dashboard/src/lib/types.ts` — add `DiffEvent` type.
- Modify: `dashboard/src/lib/api.ts` — add `listDiffEvents`.

- [ ] **Step 1: Add the `DiffEvent` type**

In `dashboard/src/lib/types.ts`, after the existing `NamedSession` type, add:

```ts
export type DiffTool = "Edit" | "Write" | "MultiEdit";

export interface DiffEvent {
  event_id: string;
  container_id: number;
  claude_session_id: string | null;
  tool_use_id: string;
  tool: DiffTool;
  path: string;
  diff: string;
  added_lines: number;
  removed_lines: number;
  size_bytes: number;
  timestamp: string;
  created_at: string;
}
```

- [ ] **Step 2: Add the `listDiffEvents` REST wrapper**

In `dashboard/src/lib/api.ts`, alongside `listNamedSessions` and similar:

```ts
import type { DiffEvent } from "./types";

export async function listDiffEvents(containerId: number): Promise<DiffEvent[]> {
  const res = await authedFetch(`/api/containers/${containerId}/diff-events`);
  if (!res.ok) throw new Error(`listDiffEvents ${res.status}`);
  return (await res.json()) as DiffEvent[];
}
```

(`authedFetch` is the existing helper — search the file for it; if the project uses `fetch` directly with the bearer token attached via a wrapper, mirror that.)

- [ ] **Step 3: Run typecheck to confirm no errors**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/lib/types.ts dashboard/src/lib/api.ts
git commit -m "feat(m27): DiffEvent type + listDiffEvents API wrapper"
```

---

## Task 12: Dashboard — `useDiffEvents` hook

**Files:**

- Create: `dashboard/src/hooks/useDiffEvents.ts`.
- Test: `dashboard/src/hooks/__tests__/useDiffEvents.test.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/hooks/__tests__/useDiffEvents.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDiffEvents } from "../useDiffEvents";
import type { DiffEvent } from "../../lib/types";

const mockList = vi.hoisted(() => vi.fn<(id: number) => Promise<DiffEvent[]>>());
const mockSubscribe = vi.hoisted(() => vi.fn<(channels: string[]) => void>());
const mockUnsubscribe = vi.hoisted(() => vi.fn<(channels: string[]) => void>());
type WsFrame = { channel: string; event: string; data: unknown };
type WsListener = (frame: WsFrame) => void;
const mockOnChannel = vi.hoisted(() => vi.fn<(c: string, cb: WsListener) => () => void>());

vi.mock("../../lib/api", () => ({
  listDiffEvents: mockList,
}));

vi.mock("../useWebSocket", () => ({
  useHiveWebSocket: () => ({
    connected: true,
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    onChannel: mockOnChannel,
  }),
}));

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function ev(id: string, path: string, ts = "2026-04-23T07:38:00Z"): DiffEvent {
  return {
    event_id: id,
    container_id: 1,
    claude_session_id: null,
    tool_use_id: "t-" + id,
    tool: "Edit",
    path,
    diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
    added_lines: 1,
    removed_lines: 1,
    size_bytes: 30,
    timestamp: ts,
    created_at: ts,
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockSubscribe.mockReset();
  mockUnsubscribe.mockReset();
  mockOnChannel.mockReset();
  mockOnChannel.mockImplementation(() => () => {});
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  qc.clear();
});

describe("useDiffEvents", () => {
  it("returns empty when containerId is null", () => {
    const { result } = renderHook(() => useDiffEvents(null), { wrapper });
    expect(result.current.events).toEqual([]);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("fetches via REST when containerId is set", async () => {
    mockList.mockResolvedValue([ev("a", "/a"), ev("b", "/b")]);
    const { result } = renderHook(() => useDiffEvents(1), { wrapper });
    await waitFor(() => expect(result.current.events.length).toBe(2));
    expect(result.current.events[0].event_id).toBe("a");
  });

  it("subscribes to diff-events:<id> on mount and unsubscribes on change", () => {
    mockList.mockResolvedValue([]);
    const { rerender } = renderHook(({ id }: { id: number | null }) => useDiffEvents(id), {
      wrapper,
      initialProps: { id: 1 as number | null },
    });
    expect(mockSubscribe).toHaveBeenCalledWith(["diff-events:1"]);
    rerender({ id: 2 });
    expect(mockUnsubscribe).toHaveBeenCalledWith(["diff-events:1"]);
    expect(mockSubscribe).toHaveBeenCalledWith(["diff-events:2"]);
  });

  it("prepends incoming `new` frames to the cache", async () => {
    mockList.mockResolvedValue([ev("a", "/a")]);
    const { result } = renderHook(() => useDiffEvents(1), { wrapper });
    await waitFor(() => expect(result.current.events.length).toBe(1));
    const listener = mockOnChannel.mock.calls[0][1];
    act(() => {
      listener({
        channel: "diff-events:1",
        event: "new",
        data: ev("z", "/z"),
      });
    });
    await waitFor(() => expect(result.current.events.map((e) => e.event_id)).toEqual(["z", "a"]));
  });

  it("caps the cache at 200 client-side", async () => {
    const initial = Array.from({ length: 200 }, (_, i) =>
      ev(`e${i}`, `/p${i}`, `2026-04-23T07:${String(i % 60).padStart(2, "0")}:00Z`),
    );
    mockList.mockResolvedValue(initial);
    const { result } = renderHook(() => useDiffEvents(1), { wrapper });
    await waitFor(() => expect(result.current.events.length).toBe(200));
    const listener = mockOnChannel.mock.calls[0][1];
    act(() => {
      listener({ channel: "diff-events:1", event: "new", data: ev("z", "/z") });
    });
    await waitFor(() => {
      expect(result.current.events.length).toBe(200);
      expect(result.current.events[0].event_id).toBe("z");
      expect(result.current.events.find((e) => e.event_id === "e199")).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests and confirm fail**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useDiffEvents.test.tsx
```

Expected: FAIL — `Cannot find module '../useDiffEvents'`.

- [ ] **Step 3: Implement the hook**

Create `dashboard/src/hooks/useDiffEvents.ts`:

```ts
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { listDiffEvents } from "../lib/api";
import type { DiffEvent } from "../lib/types";
import { useHiveWebSocket } from "./useWebSocket";

export const DIFF_EVENT_CACHE_CAP = 200;

export interface UseDiffEventsResult {
  events: DiffEvent[];
  isLoading: boolean;
  error: unknown;
}

export function useDiffEvents(containerId: number | null): UseDiffEventsResult {
  const qc = useQueryClient();
  const queryKey = ["diff-events", containerId] as const;
  const ws = useHiveWebSocket();

  const query = useQuery({
    queryKey,
    queryFn: () => listDiffEvents(containerId as number),
    enabled: containerId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // M27 — WS push: every recorded diff event broadcasts on
  // diff-events:<id>. Listener prepends to the cache.
  // 30s staleTime + refetchOnWindowFocus stay as the fallback for
  // events missed during a reconnect gap.
  useEffect(() => {
    if (containerId === null) return;
    const channel = `diff-events:${containerId}`;
    ws.subscribe([channel]);
    const removeListener = ws.onChannel(channel, (frame) => {
      if (frame.event !== "new") return;
      const incoming = frame.data as DiffEvent;
      qc.setQueryData<DiffEvent[]>(queryKey, (prev) => {
        const base = prev ?? [];
        const next = [incoming, ...base];
        return next.length > DIFF_EVENT_CACHE_CAP ? next.slice(0, DIFF_EVENT_CACHE_CAP) : next;
      });
    });
    return () => {
      removeListener();
      ws.unsubscribe([channel]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, ws, qc]);

  return {
    events: query.data ?? [],
    isLoading: query.isFetching,
    error: query.error,
  };
}
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useDiffEvents.test.tsx
```

Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/hooks/useDiffEvents.ts \
        dashboard/src/hooks/__tests__/useDiffEvents.test.tsx
git commit -m "feat(m27): useDiffEvents hook (REST + WS subscribe + cache cap)"
```

---

## Task 13: Dashboard — `DiffViewerTab` component

**Files:**

- Modify: `dashboard/package.json` — add `react-diff-view`, `gitdiff-parser`, `prismjs`.
- Create: `dashboard/src/components/DiffViewerTab.tsx`.
- Test: `dashboard/src/components/__tests__/DiffViewerTab.test.tsx`.

**Visual reference**: `.superpowers/brainstorm/*/content/m27-dashboard.html` — match the toolbar layout (tool icon · path · timestamp · stat in the meta region · `[Unified | Split]` toggle · Open file · Copy patch buttons), the diff body styling (recessed line numbers, `+`/`−` markers as colored bars not full-row backgrounds, italic hunk headers, JetBrains Mono code, Prism syntax tokens), and the toast slide-up on copy-patch.

- [ ] **Step 1: Install the npm dependencies**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npm install react-diff-view gitdiff-parser prismjs
npm install --save-dev @types/prismjs
```

- [ ] **Step 2: Write the failing tests**

Create `dashboard/src/components/__tests__/DiffViewerTab.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { DiffViewerTab } from "../DiffViewerTab";
import type { DiffEvent } from "../../lib/types";

const sample: DiffEvent = {
  event_id: "e1",
  container_id: 1,
  claude_session_id: null,
  tool_use_id: "t1",
  tool: "Edit",
  path: "/workspace/foo.ts",
  diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-const x = 1;\n+const x = 2;\n",
  added_lines: 1,
  removed_lines: 1,
  size_bytes: 80,
  timestamp: "2026-04-23T07:38:00Z",
  created_at: "2026-04-23T07:38:00Z",
};

describe("DiffViewerTab", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
  });

  it("renders the tool, path, and stat in the header", () => {
    render(<DiffViewerTab event={sample} onOpenFile={() => {}} />);
    expect(screen.getByText(/foo\.ts/)).toBeTruthy();
    expect(screen.getByText(/\+1/)).toBeTruthy();
    expect(screen.getByText(/−1|—1|-1/)).toBeTruthy();
  });

  it("toggles between Unified and Split modes", () => {
    render(<DiffViewerTab event={sample} onOpenFile={() => {}} />);
    const split = screen.getByRole("button", { name: /split/i });
    fireEvent.click(split);
    expect(split.getAttribute("data-on")).toBe("true");
    const unified = screen.getByRole("button", { name: /unified/i });
    fireEvent.click(unified);
    expect(unified.getAttribute("data-on")).toBe("true");
  });

  it("calls onOpenFile when Open file is clicked", () => {
    const onOpenFile = vi.fn();
    render(<DiffViewerTab event={sample} onOpenFile={onOpenFile} />);
    fireEvent.click(screen.getByRole("button", { name: /open file/i }));
    expect(onOpenFile).toHaveBeenCalledWith("/workspace/foo.ts");
  });

  it("copies diff text on Copy patch", async () => {
    render(<DiffViewerTab event={sample} onOpenFile={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /copy patch/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(sample.diff);
  });

  it("persists the view-mode preference to localStorage", () => {
    localStorage.removeItem("hive:diff-view-mode");
    render(<DiffViewerTab event={sample} onOpenFile={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /split/i }));
    expect(localStorage.getItem("hive:diff-view-mode")).toBe("split");
  });
});
```

- [ ] **Step 3: Run tests and confirm fail**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/DiffViewerTab.test.tsx
```

Expected: FAIL — module missing.

- [ ] **Step 4: Implement the component**

Create `dashboard/src/components/DiffViewerTab.tsx`:

```tsx
import { useState, useEffect, useMemo } from "react";
import { Copy, ExternalLink, FilePlus, FileText, Pencil } from "lucide-react";
// react-diff-view's `tokenize` is the standard helper for syntax-highlighted output.
// gitdiff-parser turns the unified-diff text into the parsed shape react-diff-view expects.
import { Diff, Hunk, parseDiff, tokenize } from "react-diff-view";
import refractor from "refractor";
import "react-diff-view/style/index.css";

import type { DiffEvent, DiffTool } from "../lib/types";

type ViewMode = "unified" | "split";

const TOOL_ACCENT: Record<DiffTool, string> = {
  Edit: "text-sky-400",
  Write: "text-emerald-400",
  MultiEdit: "text-violet-400",
};

const TOOL_ICON: Record<DiffTool, typeof Pencil> = {
  Edit: Pencil,
  Write: FilePlus,
  MultiEdit: FileText,
};

function loadStoredMode(): ViewMode {
  if (typeof window === "undefined") return "unified";
  const v = window.localStorage.getItem("hive:diff-view-mode");
  return v === "split" ? "split" : "unified";
}

interface Props {
  event: DiffEvent;
  onOpenFile: (path: string) => void;
}

export function DiffViewerTab({ event, onOpenFile }: Props) {
  const [mode, setMode] = useState<ViewMode>(loadStoredMode);
  const [showCopiedToast, setShowCopiedToast] = useState(false);

  useEffect(() => {
    window.localStorage.setItem("hive:diff-view-mode", mode);
  }, [mode]);

  const files = useMemo(() => parseDiff(event.diff), [event.diff]);
  const tokens = useMemo(() => {
    try {
      return files.map((f) =>
        tokenize(f.hunks, {
          highlight: true,
          refractor,
          oldSource: undefined,
          language: detectLanguage(event.path),
        }),
      );
    } catch {
      return files.map(() => null);
    }
  }, [files, event.path]);

  const ToolIcon = TOOL_ICON[event.tool];
  const accent = TOOL_ACCENT[event.tool];

  const onCopy = async () => {
    await navigator.clipboard.writeText(event.diff);
    setShowCopiedToast(true);
    window.setTimeout(() => setShowCopiedToast(false), 1600);
  };

  return (
    <div className="flex h-full flex-col bg-gray-950 text-gray-200">
      <div className="flex h-11 items-center gap-3 border-b border-gray-800 px-4">
        <ToolIcon className={`h-4 w-4 ${accent}`} strokeWidth={1.7} />
        <div className="font-mono text-sm">
          <span className="text-gray-500">{dirOf(event.path)}/</span>
          <span className="text-gray-200">{baseOf(event.path)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <span>·</span>
          <span>{relativeTime(event.created_at)}</span>
          <span>·</span>
          <span className="font-mono">
            <span className="text-emerald-400">+{event.added_lines}</span>
            <span className="mx-0.5 text-gray-600">·</span>
            <span className="text-rose-400">−{event.removed_lines}</span>
          </span>
        </div>
        <div className="flex-1" />
        <div className="flex rounded border border-gray-700 bg-gray-900 p-0.5 text-xs font-medium">
          <button
            type="button"
            onClick={() => setMode("unified")}
            data-on={mode === "unified"}
            className={
              mode === "unified"
                ? "rounded bg-gray-950 px-3 py-1 text-gray-100 ring-1 ring-gray-700"
                : "px-3 py-1 text-gray-400 hover:text-gray-200"
            }
          >
            Unified
          </button>
          <button
            type="button"
            onClick={() => setMode("split")}
            data-on={mode === "split"}
            className={
              mode === "split"
                ? "rounded bg-gray-950 px-3 py-1 text-gray-100 ring-1 ring-gray-700"
                : "px-3 py-1 text-gray-400 hover:text-gray-200"
            }
          >
            Split
          </button>
        </div>
        <button
          type="button"
          onClick={() => onOpenFile(event.path)}
          className="inline-flex items-center gap-1.5 rounded border border-gray-700 bg-gray-900 px-2.5 py-1 text-xs font-medium text-gray-400 hover:border-gray-500 hover:text-gray-200"
        >
          <ExternalLink className="h-3 w-3" strokeWidth={1.8} />
          Open file
        </button>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded border border-gray-700 bg-gray-900 px-2.5 py-1 text-xs font-medium text-gray-400 hover:border-gray-500 hover:text-gray-200"
        >
          <Copy className="h-3 w-3" strokeWidth={1.8} />
          Copy patch
        </button>
      </div>
      <div className="flex-1 overflow-auto bg-gray-950 font-mono text-[12.5px] leading-[1.55]">
        {files.map((file, i) => (
          <Diff
            key={i}
            viewType={mode === "unified" ? "unified" : "split"}
            diffType={file.type}
            hunks={file.hunks}
            tokens={tokens[i] ?? undefined}
          >
            {(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
          </Diff>
        ))}
      </div>
      {showCopiedToast && (
        <div className="pointer-events-none fixed bottom-8 right-8 flex items-center gap-2 rounded-md border border-emerald-500 bg-gray-900 px-4 py-2.5 text-xs text-gray-100 shadow-xl">
          <svg
            className="h-3.5 w-3.5 text-emerald-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
          Diff copied to clipboard
        </div>
      )}
    </div>
  );
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}

function baseOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function detectLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    sh: "bash",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    yml: "yaml",
    yaml: "yaml",
  };
  return map[ext] ?? "plaintext";
}
```

(Note: the test uses `getByRole("button", { name: /split/i })`. The component uses `<button>` with text "Split" — react-testing-library's accessible-name resolution finds it by text content. If the rendered button text differs in your final pass, adjust the test selectors.)

- [ ] **Step 5: Run tests and confirm they pass**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/DiffViewerTab.test.tsx
```

Expected: 5/5 PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/package.json dashboard/package-lock.json \
        dashboard/src/components/DiffViewerTab.tsx \
        dashboard/src/components/__tests__/DiffViewerTab.test.tsx
git commit -m "feat(m27): DiffViewerTab — react-diff-view + unified↔split toggle"
```

---

## Task 14: Dashboard — `DiffEventsActivity` sidebar

**Files:**

- Create: `dashboard/src/components/DiffEventsActivity.tsx`.
- Test: `dashboard/src/components/__tests__/DiffEventsActivity.test.tsx`.

**Visual reference**: same mockup. Match the tool color gutter (2-pixel left border, blue / green / purple), monospace path with greyed parent dirs, sticky lowercase mono date headers (`today`, `yesterday`, `this week`, `older`), search input in pane header, `+14 · −8` stat at the right edge.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/components/__tests__/DiffEventsActivity.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { DiffEventsActivity } from "../DiffEventsActivity";
import type { DiffEvent } from "../../lib/types";

const mockUseDiffEvents = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/useDiffEvents", () => ({
  useDiffEvents: mockUseDiffEvents,
}));

const todayIso = new Date().toISOString();
const yesterday = new Date(Date.now() - 86_400_000).toISOString();

function ev(id: string, path: string, ts: string, tool: DiffEvent["tool"] = "Edit"): DiffEvent {
  return {
    event_id: id,
    container_id: 1,
    claude_session_id: null,
    tool_use_id: "t" + id,
    tool,
    path,
    diff: "--- a\n+++ b\n",
    added_lines: 14,
    removed_lines: 8,
    size_bytes: 30,
    timestamp: ts,
    created_at: ts,
  };
}

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockUseDiffEvents.mockReset();
});

describe("DiffEventsActivity", () => {
  it("renders date-grouped events", () => {
    mockUseDiffEvents.mockReturnValue({
      events: [ev("e1", "/a/today.ts", todayIso), ev("e2", "/a/y.ts", yesterday)],
      isLoading: false,
      error: null,
    });
    render(<DiffEventsActivity containerId={1} onOpenEvent={() => {}} />, { wrapper });
    expect(screen.getByText(/today/i)).toBeTruthy();
    expect(screen.getByText(/yesterday/i)).toBeTruthy();
  });

  it("filters rows by path with the search input", () => {
    mockUseDiffEvents.mockReturnValue({
      events: [ev("e1", "/dashboard/App.tsx", todayIso), ev("e2", "/hub/main.py", todayIso)],
      isLoading: false,
      error: null,
    });
    render(<DiffEventsActivity containerId={1} onOpenEvent={() => {}} />, { wrapper });
    const input = screen.getByPlaceholderText(/filter by path/i);
    fireEvent.change(input, { target: { value: "main" } });
    expect(screen.queryByText(/App\.tsx/)).toBeNull();
    expect(screen.getByText(/main\.py/)).toBeTruthy();
  });

  it("calls onOpenEvent when a row is clicked", () => {
    const onOpenEvent = vi.fn();
    const e = ev("e1", "/a/x.ts", todayIso);
    mockUseDiffEvents.mockReturnValue({ events: [e], isLoading: false, error: null });
    render(<DiffEventsActivity containerId={1} onOpenEvent={onOpenEvent} />, { wrapper });
    fireEvent.click(screen.getByText("x.ts").closest("[data-row]")!);
    expect(onOpenEvent).toHaveBeenCalledWith(e);
  });

  it("shows a tool color gutter on each row (data-tool attr)", () => {
    mockUseDiffEvents.mockReturnValue({
      events: [
        ev("e1", "/a", todayIso, "Edit"),
        ev("e2", "/b", todayIso, "Write"),
        ev("e3", "/c", todayIso, "MultiEdit"),
      ],
      isLoading: false,
      error: null,
    });
    render(<DiffEventsActivity containerId={1} onOpenEvent={() => {}} />, { wrapper });
    const rows = document.querySelectorAll("[data-row]");
    expect(rows[0].getAttribute("data-tool")).toBe("Edit");
    expect(rows[1].getAttribute("data-tool")).toBe("Write");
    expect(rows[2].getAttribute("data-tool")).toBe("MultiEdit");
  });
});
```

- [ ] **Step 2: Run and confirm fail**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/DiffEventsActivity.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement the component**

Create `dashboard/src/components/DiffEventsActivity.tsx`:

```tsx
import { useState, useMemo } from "react";
import { History, Pencil, FilePlus, FileText, Search } from "lucide-react";

import { useDiffEvents } from "../hooks/useDiffEvents";
import type { DiffEvent, DiffTool } from "../lib/types";

const TOOL_ICON: Record<DiffTool, typeof Pencil> = {
  Edit: Pencil,
  Write: FilePlus,
  MultiEdit: FileText,
};

const TOOL_BORDER: Record<DiffTool, string> = {
  Edit: "border-l-sky-400",
  Write: "border-l-emerald-400",
  MultiEdit: "border-l-violet-400",
};

const TOOL_TEXT: Record<DiffTool, string> = {
  Edit: "text-sky-400",
  Write: "text-emerald-400",
  MultiEdit: "text-violet-400",
};

interface Props {
  containerId: number;
  onOpenEvent: (event: DiffEvent) => void;
}

export function DiffEventsActivity({ containerId, onOpenEvent }: Props) {
  const { events } = useDiffEvents(containerId);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter.trim()) return events;
    const q = filter.toLowerCase();
    return events.filter((e) => e.path.toLowerCase().includes(q));
  }, [events, filter]);

  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  return (
    <div className="flex h-full flex-col bg-gray-900 text-gray-200">
      <header className="border-b border-gray-800 p-3">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          <History className="h-3 w-3" strokeWidth={1.8} />
          Recent Edits
          <span className="ml-auto rounded-full bg-gray-800 px-1.5 py-px text-[10px] font-medium text-gray-500">
            {events.length}
          </span>
        </div>
        <div className="relative">
          <Search
            className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-600"
            strokeWidth={1.8}
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by path…"
            className="w-full rounded border border-gray-700 bg-gray-950 py-1.5 pl-7 pr-2 text-xs text-gray-200 placeholder:text-gray-600 focus:border-sky-500 focus:outline-none"
          />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        {groups.map((g) => (
          <section key={g.label}>
            <h3 className="sticky top-0 z-10 bg-gray-900 px-4 pb-1.5 pt-3 font-mono text-[10px] font-semibold uppercase tracking-widest text-gray-600">
              {g.label}
            </h3>
            {g.items.map((e) => {
              const Icon = TOOL_ICON[e.tool];
              return (
                <div
                  key={e.event_id}
                  data-row
                  data-tool={e.tool}
                  onClick={() => onOpenEvent(e)}
                  className={`flex cursor-pointer items-center gap-2.5 border-l-2 px-3.5 py-2 hover:bg-gray-800 ${TOOL_BORDER[e.tool]}`}
                >
                  <Icon className={`h-3.5 w-3.5 ${TOOL_TEXT[e.tool]}`} strokeWidth={1.7} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12px] leading-tight">
                      <span className="text-gray-600">{dirOf(e.path)}/</span>
                      <span className="text-gray-200">{baseOf(e.path)}</span>
                    </div>
                    <div className="mt-px text-[11px] text-gray-600">
                      {relativeTime(e.created_at)}
                    </div>
                  </div>
                  <div className="font-mono text-[11px] tabular-nums">
                    {e.added_lines > 0 && (
                      <span className="text-emerald-400">+{e.added_lines}</span>
                    )}
                    {e.added_lines > 0 && e.removed_lines > 0 && (
                      <span className="mx-0.5 text-gray-600">·</span>
                    )}
                    {e.removed_lines > 0 && (
                      <span className="text-rose-400">−{e.removed_lines}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

interface Group {
  label: string;
  items: DiffEvent[];
}

function groupByDate(events: DiffEvent[]): Group[] {
  const today: DiffEvent[] = [];
  const yesterday: DiffEvent[] = [];
  const thisWeek: DiffEvent[] = [];
  const older: DiffEvent[] = [];
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfDay - 86_400_000;
  const startOfWeek = startOfDay - 6 * 86_400_000;

  for (const e of events) {
    const t = new Date(e.created_at).getTime();
    if (t >= startOfDay) today.push(e);
    else if (t >= startOfYesterday) yesterday.push(e);
    else if (t >= startOfWeek) thisWeek.push(e);
    else older.push(e);
  }

  const groups: Group[] = [];
  if (today.length) groups.push({ label: "today", items: today });
  if (yesterday.length) groups.push({ label: "yesterday", items: yesterday });
  if (thisWeek.length) groups.push({ label: "this week", items: thisWeek });
  if (older.length) groups.push({ label: "older", items: older });
  return groups;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}

function baseOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
```

- [ ] **Step 4: Run tests and confirm pass**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/DiffEventsActivity.test.tsx
```

Expected: 4/4 PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/DiffEventsActivity.tsx \
        dashboard/src/components/__tests__/DiffEventsActivity.test.tsx
git commit -m "feat(m27): DiffEventsActivity sidebar — date groups + path filter"
```

---

## Task 15: Dashboard — ActivityBar registration + App.tsx integration

**Files:**

- Modify: `dashboard/src/components/ActivityBar.tsx` — register the new entry.
- Modify: `dashboard/src/App.tsx` — render the new sidebar conditional + tab opening logic.

- [ ] **Step 1: Register the new activity in `ActivityBar.tsx`**

In `dashboard/src/components/ActivityBar.tsx`, add `History` (or your chosen icon) to the `lucide-react` imports, then add a new entry to the bar's existing list of activity buttons:

```tsx
{
  id: "diff-events",
  icon: History,
  label: "Recent Edits",
  // existing fields per your bar's pattern (keyboard shortcut, etc.)
}
```

Match the existing pattern — if there's a `BarItem` array, append; if it's hand-coded buttons, add another.

- [ ] **Step 2: Wire the sidebar + tab in `App.tsx`**

Find the existing `activeActivity` state (or equivalent) and the conditional that renders the sidebar pane. Add a branch:

```tsx
{
  activeActivity === "diff-events" && (
    <DiffEventsActivity
      containerId={selectedContainerId}
      onOpenEvent={(e) =>
        openTab({
          kind: "diff-event",
          eventId: e.event_id,
          path: e.path,
          title: `${baseOf(e.path)} · diff`,
          render: () => <DiffViewerTab event={e} onOpenFile={openFileInViewer} />,
        })
      }
    />
  );
}
```

The exact `openTab` and `openFileInViewer` signatures depend on the existing tab infrastructure used by M16 sessions and M18 file viewer. Mirror their pattern.

- [ ] **Step 3: Run typecheck + the full vitest suite**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

Both clean.

- [ ] **Step 4: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/ActivityBar.tsx dashboard/src/App.tsx
git commit -m "feat(m27): wire DiffEventsActivity into ActivityBar + App"
```

---

## Task 16: Playwright happy-path E2E

**Files:**

- Create: `dashboard/tests/e2e/diff-events.spec.ts`.

- [ ] **Step 1: Write the spec**

Create `dashboard/tests/e2e/diff-events.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("diff event appears in sidebar and renders in viewer tab", async ({ page }) => {
  // The CI Playwright fixture seeds a container with id=1 and provides
  // a `seedDiffEvent` test hook (see dashboard/tests/e2e/_seed.ts).
  // Mirror that pattern from existing e2e specs (named-sessions.spec.ts).
  await page.goto("/");

  // Open the new "Recent Edits" activity.
  await page.getByRole("button", { name: /recent edits/i }).click();

  // Seed an event via the test API + WebSocket (see existing e2e helpers).
  await seedDiffEvent(page, {
    container_id: 1,
    tool: "Edit",
    path: "/workspace/foo.ts",
    diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n",
    added_lines: 1,
    removed_lines: 1,
  });

  const row = page.getByText("foo.ts");
  await expect(row).toBeVisible({ timeout: 5000 });

  await row.click();

  // Diff viewer tab opens and renders.
  await expect(page.getByRole("button", { name: /unified/i })).toBeVisible();
  await expect(page.getByText("+1")).toBeVisible();

  // Toggle split.
  await page.getByRole("button", { name: /split/i }).click();
  await expect(page.getByRole("button", { name: /split/i })).toHaveAttribute("data-on", "true");

  // Copy patch.
  await page.getByRole("button", { name: /copy patch/i }).click();
  await expect(page.getByText(/diff copied/i)).toBeVisible();
});

async function seedDiffEvent(page: any, payload: Record<string, unknown>) {
  // Implementation detail: in a real run, this either POSTs to a
  // test-only endpoint that bypasses the agent path, OR opens a
  // mock WS server (MSW-WS) and pushes a `diff-events:1` frame.
  // Match whatever pattern named-sessions.spec.ts uses.
  await page.evaluate((p) => {
    window.dispatchEvent(new CustomEvent("hive:test:seed-diff", { detail: p }));
  }, payload);
}
```

- [ ] **Step 2: Run the e2e tests**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test diff-events.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/tests/e2e/diff-events.spec.ts
git commit -m "test(m27): playwright happy path for diff event sidebar + viewer"
```

---

## Task 17: Pre-flight regression sweep

- [ ] **Step 1: Hub regression**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run ruff check . && uv run mypy . && uv run pytest tests -q
```

Expected: all green.

- [ ] **Step 2: hive-agent regression**

```bash
cd /home/gnava/repos/honeycomb/hive-agent
uv run ruff check . && uv run mypy . && uv run pytest tests -q
```

Expected: all green.

- [ ] **Step 3: Dashboard typecheck + lint + vitest**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npm run lint
npx vitest run
```

Expected: all green. **Use `tsc -b` (composite), not `tsc --noEmit`** — CI runs the composite resolver and catches errors the root config misses.

- [ ] **Step 4: Prettier sweep**

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write .
cd /home/gnava/repos/honeycomb
git status
git diff
```

Expected: zero or tiny diff on M27-touched files. If prettier reformats unrelated files, STOP and investigate (this would mean an older commit drifted).

- [ ] **Step 5: Commit any prettier-reformatted output**

```bash
cd /home/gnava/repos/honeycomb
git add -A
git diff --cached --quiet || git commit -m "style(m27): prettier sweep before push"
```

- [ ] **Step 6: pre-commit run**

```bash
cd /home/gnava/repos/honeycomb
pre-commit run --all-files
```

Expected: clean.

- [ ] **Step 7: docker-build smoke (optional but matches CI)**

```bash
cd /home/gnava/repos/honeycomb
docker build -f bootstrapper/templates/base/Dockerfile --target dev \
  -t honeycomb-base:dev bootstrapper/templates/base
```

Expected: build succeeds. (Can be skipped locally if Docker isn't running; CI runs this.)

---

## Task 18: Merge + tag + push + CI watch + branch delete

- [ ] **Step 1: Push the branch and watch CI**

```bash
cd /home/gnava/repos/honeycomb
git push -u origin m27-claude-diff-view
gh run watch --exit-status $(gh run list --branch m27-claude-diff-view --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: CI green. If hub pytest hangs (we observed this on M30 — transient runner glitch), cancel + rerun.

- [ ] **Step 2: Merge to main**

```bash
cd /home/gnava/repos/honeycomb
git checkout main
git pull --ff-only origin main
git merge --no-ff m27-claude-diff-view -m "Merge M27: ε Claude diff view"
```

- [ ] **Step 3: Tag v0.27-claude-diff-view**

```bash
cd /home/gnava/repos/honeycomb
git tag -a v0.27-claude-diff-view -m "M27: Claude diff view (PostToolUse hook + diff_events table + react-diff-view UI)"
```

- [ ] **Step 4: Push with --follow-tags**

```bash
cd /home/gnava/repos/honeycomb
git push --follow-tags origin main
```

- [ ] **Step 5: Watch the merge-commit CI run**

```bash
cd /home/gnava/repos/honeycomb
sleep 10 && gh run list --branch main --limit 1
gh run watch --exit-status $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected: green.

- [ ] **Step 6: Delete the merged branch**

```bash
cd /home/gnava/repos/honeycomb
git branch -d m27-claude-diff-view
git push origin --delete m27-claude-diff-view
```

---

## Verification Checklist

Before marking the milestone done, confirm:

- [ ] `cd hub && uv run pytest tests -q` — all green (M30's 360 + M27's new tests).
- [ ] `cd hub && uv run ruff check . && uv run mypy .` — clean.
- [ ] `cd hive-agent && uv run pytest tests -q` — green.
- [ ] `cd dashboard && npx tsc -b --noEmit && npm run lint && npx vitest run` — green.
- [ ] `cd dashboard && npx playwright test` — green (or at least the new diff-events spec).
- [ ] `pre-commit run --all-files` — clean.
- [ ] `git log --oneline main` shows the merge commit + the v0.27 tag.
- [ ] `gh run list --branch main --limit 1` shows the merge-CI green.
- [ ] Branch `m27-claude-diff-view` deleted locally and on origin.
- [ ] (Manual, optional) Live sanity: launch hub, register a real container, edit a file via Claude inside the container, watch the row appear in the dashboard sidebar within ~1s, click, render, toggle split, copy patch.
