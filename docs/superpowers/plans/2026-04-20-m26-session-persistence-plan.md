# M26 Implementation Plan — Persistent named sessions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move per-container named session tabs from localStorage to a hub-side `sessions` table with a new CRUD router, client hook, and one-shot migration — so session names survive hub restart and are shared across every Tailscale-reachable device.

**Architecture:** New `sessions` table (Alembic migration) with `session_id` UUID PK, `container_id` FK CASCADE to containers, `name`, `kind`, `created_at`, `updated_at`. A four-method CRUD router at `/api/containers/{id}/named-sessions` + `/api/named-sessions/{session_id}` wraps a thin async service layer (`hub/services/named_sessions.py`). Dashboard gets a `useSessions` hook (TanStack Query with optimistic mutations) and a `runSessionMigration()` helper that one-shot migrates legacy localStorage into the hub, rewrites dependent keys, wipes PTY sessionStorage labels (fresh terminals accepted per user trade-off), and sets an idempotency guard.

**Tech Stack:** SQLAlchemy async + Alembic + FastAPI on the backend; React 19 + TanStack Query v5 + Vitest + Playwright on the dashboard.

---

## File structure

### Created

- `hub/db/migrations/versions/2026_04_20_XXXX-m26_sessions_table.py` — Alembic migration (exact filename follows the existing `YYYY_MM_DD_HHMM-<slug>.py` pattern)
- `hub/services/named_sessions.py` — service helpers + `SessionNotFound`
- `hub/routers/named_sessions.py` — router with 4 endpoints
- `hub/tests/test_named_sessions_service.py` — service tests
- `hub/tests/test_named_sessions_endpoint.py` — endpoint tests
- `dashboard/src/lib/migrateSessions.ts` — one-shot migration
- `dashboard/src/lib/__tests__/migrateSessions.test.ts` — vitest (note: `lib/` doesn't have a `__tests__/` today; create it)
- `dashboard/src/hooks/useSessions.ts` — hook
- `dashboard/src/hooks/__tests__/useSessions.test.tsx` — vitest
- `dashboard/tests/e2e/named-sessions.spec.ts` — Playwright

### Modified

- `hub/models/schemas.py` — `NamedSession`, `NamedSessionCreate`, `NamedSessionPatch`
- `hub/db/schema.py` — SQLAlchemy metadata entry for the new table (if the project registers tables here)
- `hub/main.py` — register `named_sessions.router`
- `dashboard/src/lib/api.ts` — four new wrappers
- `dashboard/src/lib/types.ts` — `NamedSession`, `NamedSessionCreate`, `SessionKind`
- `dashboard/src/App.tsx` — swap localStorage readers for `useSessions`; run migration on mount; auto-seed default session on empty

---

## Task 1: Alembic migration for `sessions` table

**Files:**

- Create: `hub/db/migrations/versions/2026_04_20_1200-m26_sessions_table.py`
- Create: `hub/tests/test_m26_sessions_migration.py`

- [ ] **Step 1: Write failing test.**

Create `hub/tests/test_m26_sessions_migration.py`:

```python
"""M26 — verify Alembic creates the sessions table with correct shape."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa


@pytest.mark.asyncio
async def test_sessions_table_exists_after_migration(tmp_path: Path) -> None:
    from hub.db.migrations_runner import apply_migrations_sync

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)

    engine = sa.create_engine(f"sqlite:///{db_path}")
    inspector = sa.inspect(engine)
    assert "sessions" in inspector.get_table_names()

    cols = {c["name"]: c for c in inspector.get_columns("sessions")}
    assert set(cols) == {
        "session_id",
        "container_id",
        "name",
        "kind",
        "created_at",
        "updated_at",
    }
    assert cols["session_id"]["primary_key"] == 1

    fks = inspector.get_foreign_keys("sessions")
    assert len(fks) == 1
    assert fks[0]["referred_table"] == "containers"
    assert fks[0]["referred_columns"] == ["id"]
    # SQLite stores on_delete as a string.
    assert fks[0].get("options", {}).get("ondelete", "").upper() == "CASCADE"

    indexes = inspector.get_indexes("sessions")
    by_name = {ix["name"]: ix for ix in indexes}
    assert "ix_sessions_container_id" in by_name
    assert by_name["ix_sessions_container_id"]["column_names"] == ["container_id"]


@pytest.mark.asyncio
async def test_cascade_on_container_delete(tmp_path: Path) -> None:
    """Deleting a container wipes its session rows via FK CASCADE."""
    from hub.db.migrations_runner import apply_migrations_sync

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)

    engine = sa.create_engine(f"sqlite:///{db_path}")
    # SQLite needs foreign_keys=ON per-connection.
    @sa.event.listens_for(engine, "connect")
    def _fk_on(conn, _r):
        conn.execute("PRAGMA foreign_keys=ON")

    with engine.begin() as conn:
        # Insert a container row. Columns mirror the M13 schema.
        conn.execute(
            sa.text(
                "INSERT INTO containers "
                "(workspace_folder, project_type, project_name, "
                "project_description, container_status, agent_status, "
                "agent_port, has_gpu, has_claude_cli, agent_expected) "
                "VALUES ('/w','base','demo','','running','idle',0,0,0,1)",
            ),
        )
        cid_row = conn.execute(sa.text("SELECT id FROM containers LIMIT 1")).first()
        assert cid_row is not None
        container_id = cid_row[0]
        conn.execute(
            sa.text(
                "INSERT INTO sessions "
                "(session_id, container_id, name, kind) "
                "VALUES ('abc',:cid,'Main','shell')",
            ),
            {"cid": container_id},
        )
        conn.execute(sa.text("DELETE FROM containers WHERE id = :cid"), {"cid": container_id})
        left = conn.execute(sa.text("SELECT COUNT(*) FROM sessions")).scalar()
        assert left == 0
```

The exact columns required on the `containers` table at insert time may differ from what's shown above — consult the current schema during implementation. If this test is hard to make pass because of schema churn, keep only the first test (which inspects the table shape) and move the CASCADE verification into the service-level integration test in Task 3.

- [ ] **Step 2: Run tests; expect failure.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_m26_sessions_migration.py -v
```

Expected: `AssertionError: "sessions" table not in get_table_names()`.

- [ ] **Step 3: Discover the current migration head.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run alembic -c hub/db/alembic.ini heads 2>&1 | tail -5
```

Record the output — that's the `down_revision` for our new migration. Typically `1f4d0a7e5c21` (M13's `add_agent_expected`). If `alembic heads` prints a different head, use that instead.

- [ ] **Step 4: Create the migration file.**

Create `hub/db/migrations/versions/2026_04_20_1200-m26_sessions_table.py`:

```python
"""M26 — persistent named sessions.

Adds a ``sessions`` table so user-named session tabs survive hub
restart and sync across every Tailscale-reachable device. Each row
carries a server-generated UUID (``session_id``) plus a
container-scoped ``name`` and ``kind`` ("shell" | "claude").

Revision ID: m26_sessions
Revises: 1f4d0a7e5c21
Create Date: 2026-04-20 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Replace the down_revision below with whatever ``alembic heads``
# prints on your tree at the time of running this migration. At
# the time this plan was written the head was
# ``1f4d0a7e5c21`` (M13's add_agent_expected).
revision: str = "m26_sessions"
down_revision: str | Sequence[str] | None = "1f4d0a7e5c21"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("session_id", sa.String(length=64), primary_key=True),
        sa.Column("container_id", sa.Integer, nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.current_timestamp(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.current_timestamp(),
        ),
        sa.ForeignKeyConstraint(
            ["container_id"],
            ["containers.id"],
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_sessions_container_id",
        "sessions",
        ["container_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_sessions_container_id", table_name="sessions")
    op.drop_table("sessions")
```

- [ ] **Step 5: Run tests; expect passing.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_m26_sessions_migration.py -v
```

Expected: both tests passing.

- [ ] **Step 6: Full hub suite — catch regressions.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest -q
```

Expected: 317 + 2 = 319 passing.

- [ ] **Step 7: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add hub/db/migrations/versions/2026_04_20_1200-m26_sessions_table.py hub/tests/test_m26_sessions_migration.py
git commit -m "feat(m26): Alembic migration for sessions table"
```

---

## Task 2: Pydantic schemas + SQLAlchemy metadata

**Files:**

- Modify: `hub/models/schemas.py`
- Modify: `hub/db/schema.py` (only if the project registers tables here — see Step 1)

- [ ] **Step 1: Check if `hub/db/schema.py` declares tables.**

```bash
grep -n "sa.Table\|Metadata\|metadata" /home/gnava/repos/honeycomb/hub/db/schema.py 2>&1 | head -5
```

If the file declares SQLAlchemy Core `Table` objects, you need to add a corresponding `sessions` entry there (follow the existing pattern). If the file only holds the `MetaData` object and no tables, skip — migrations are the source of truth.

If you need to add it, create a table declaration mirroring the Alembic migration:

```python
sessions = sa.Table(
    "sessions",
    metadata,
    sa.Column("session_id", sa.String(length=64), primary_key=True),
    sa.Column("container_id", sa.Integer, sa.ForeignKey("containers.id", ondelete="CASCADE"), nullable=False),
    sa.Column("name", sa.String(length=64), nullable=False),
    sa.Column("kind", sa.String(length=16), nullable=False),
    sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.current_timestamp()),
    sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.func.current_timestamp()),
    sa.Index("ix_sessions_container_id", "container_id"),
)
```

- [ ] **Step 2: Append to `hub/models/schemas.py`.**

Place the new block near the other resource models (after `WalkResult` / `FileContent` / before the `# --- Git Ops ---` divider). Add imports only if `Literal` isn't already imported at the top.

```python
# --- M26: persistent named sessions ---


class NamedSession(BaseModel):
    """One persistent session row (M26).

    Returned by the new CRUD routes at
    ``/api/containers/{id}/named-sessions`` and
    ``/api/named-sessions/{session_id}``.
    """

    session_id: str
    container_id: int
    name: str
    kind: Literal["shell", "claude"]
    created_at: datetime
    updated_at: datetime


class NamedSessionCreate(BaseModel):
    """Body for ``POST /api/containers/{id}/named-sessions``."""

    name: str = Field(..., min_length=1, max_length=64)
    kind: Literal["shell", "claude"] = "shell"


class NamedSessionPatch(BaseModel):
    """Body for ``PATCH /api/named-sessions/{session_id}``."""

    name: str = Field(..., min_length=1, max_length=64)
```

Verify `Literal` is in the imports — `typing.Literal` or `from typing import Literal`. If missing, add it alongside the other `typing` imports at the top of the file.

- [ ] **Step 3: mypy the file.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run mypy hub/models/schemas.py
```

Expected: clean.

- [ ] **Step 4: Full hub suite.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest -q
```

Expected: 319 passing (no new tests yet; this just proves the schema additions don't regress anything).

- [ ] **Step 5: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add hub/models/schemas.py
git commit -m "feat(m26): NamedSession + NamedSessionCreate + NamedSessionPatch schemas"
# Include hub/db/schema.py too if you modified it in Step 1.
```

---

## Task 3: Service layer — `named_sessions.py` (TDD)

**Files:**

- Create: `hub/services/named_sessions.py`
- Create: `hub/tests/test_named_sessions_service.py`

- [ ] **Step 1: Write failing tests.**

Create `hub/tests/test_named_sessions_service.py`:

```python
"""Unit tests for the named_sessions service layer (M26)."""

from __future__ import annotations

from pathlib import Path

import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine

from hub.db.migrations_runner import apply_migrations_sync
from hub.services.named_sessions import (
    SessionNotFound,
    create_session,
    delete_session,
    list_sessions,
    rename_session,
)


@pytest_asyncio.fixture
async def engine(tmp_path: Path):
    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
    # FK enforcement is a connect-time PRAGMA in SQLite.
    eng = create_async_engine(f"sqlite+aiosqlite:///{db_path}")

    @sa.event.listens_for(eng.sync_engine, "connect")
    def _fk_on(conn, _r):
        conn.execute("PRAGMA foreign_keys=ON")

    # Seed a container row so sessions can FK to it.
    async with eng.begin() as conn:
        await conn.execute(
            sa.text(
                "INSERT INTO containers "
                "(workspace_folder, project_type, project_name, "
                "project_description, container_status, agent_status, "
                "agent_port, has_gpu, has_claude_cli, agent_expected) "
                "VALUES ('/w','base','demo','','running','idle',0,0,0,1)",
            ),
        )

    yield eng
    await eng.dispose()


@pytest.mark.asyncio
async def test_create_session_returns_populated_row(engine) -> None:
    session = await create_session(
        engine, container_id=1, name="Main", kind="shell"
    )
    assert len(session.session_id) == 32  # uuid4().hex
    assert session.container_id == 1
    assert session.name == "Main"
    assert session.kind == "shell"


@pytest.mark.asyncio
async def test_list_sessions_empty_by_default(engine) -> None:
    sessions = await list_sessions(engine, container_id=1)
    assert sessions == []


@pytest.mark.asyncio
async def test_list_sessions_ordered_by_created_at(engine) -> None:
    a = await create_session(engine, container_id=1, name="first", kind="shell")
    b = await create_session(engine, container_id=1, name="second", kind="claude")
    c = await create_session(engine, container_id=1, name="third", kind="shell")
    sessions = await list_sessions(engine, container_id=1)
    assert [s.session_id for s in sessions] == [a.session_id, b.session_id, c.session_id]


@pytest.mark.asyncio
async def test_rename_session_bumps_updated_at(engine) -> None:
    session = await create_session(engine, container_id=1, name="orig", kind="shell")
    renamed = await rename_session(engine, session_id=session.session_id, name="new")
    assert renamed.name == "new"
    # updated_at must be ≥ created_at (same call can match at low resolution).
    assert renamed.updated_at >= session.created_at


@pytest.mark.asyncio
async def test_rename_missing_raises(engine) -> None:
    with pytest.raises(SessionNotFound):
        await rename_session(engine, session_id="nope", name="x")


@pytest.mark.asyncio
async def test_delete_removes_row(engine) -> None:
    session = await create_session(engine, container_id=1, name="bye", kind="shell")
    await delete_session(engine, session_id=session.session_id)
    assert await list_sessions(engine, container_id=1) == []


@pytest.mark.asyncio
async def test_delete_missing_is_idempotent(engine) -> None:
    # No raise.
    await delete_session(engine, session_id="nonexistent")


@pytest.mark.asyncio
async def test_cascade_on_container_delete(engine) -> None:
    await create_session(engine, container_id=1, name="a", kind="shell")
    await create_session(engine, container_id=1, name="b", kind="shell")
    async with engine.begin() as conn:
        await conn.execute(sa.text("DELETE FROM containers WHERE id = 1"))
    sessions = await list_sessions(engine, container_id=1)
    assert sessions == []
```

- [ ] **Step 2: Run — fails on import.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_named_sessions_service.py -v
```

Expected: `ImportError` on `SessionNotFound`, `create_session`, etc.

- [ ] **Step 3: Implement the service.**

Create `hub/services/named_sessions.py`:

```python
"""Persistent session CRUD (M26).

Thin async helpers over SQLAlchemy Core. The dashboard's
``useSessions`` hook drives all four operations through the
``/api/containers/{id}/named-sessions`` + ``/api/named-sessions/{id}``
routes; this module owns the DB contract.

Session IDs are server-generated ``uuid.uuid4().hex`` — clients
never provide them. Duplicate names are allowed; the DB has no
uniqueness constraint on ``name`` (a 409 on a double-save would be
worse UX than letting both rows coexist).
"""

from __future__ import annotations

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from hub.models.schemas import NamedSession


class SessionNotFound(KeyError):
    """Raised when rename/delete targets a nonexistent session_id.

    The router maps this to HTTP 404 via exception handlers; delete
    callers swallow it (delete is idempotent by design).
    """


def _row_to_model(row: sa.RowMapping) -> NamedSession:
    return NamedSession(
        session_id=row["session_id"],
        container_id=row["container_id"],
        name=row["name"],
        kind=row["kind"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def create_session(
    engine: AsyncEngine,
    *,
    container_id: int,
    name: str,
    kind: str,
) -> NamedSession:
    """Insert a new session row and return the populated model."""
    session_id = uuid.uuid4().hex
    now = datetime.utcnow()
    async with engine.begin() as conn:
        await conn.execute(
            sa.text(
                "INSERT INTO sessions "
                "(session_id, container_id, name, kind, created_at, updated_at) "
                "VALUES (:sid, :cid, :name, :kind, :now, :now)"
            ),
            {
                "sid": session_id,
                "cid": container_id,
                "name": name,
                "kind": kind,
                "now": now,
            },
        )
        row = (
            await conn.execute(
                sa.text(
                    "SELECT session_id, container_id, name, kind, "
                    "created_at, updated_at FROM sessions "
                    "WHERE session_id = :sid"
                ),
                {"sid": session_id},
            )
        ).mappings().one()
    return _row_to_model(row)


async def list_sessions(
    engine: AsyncEngine,
    *,
    container_id: int,
) -> list[NamedSession]:
    """Return all persistent sessions for ``container_id``, oldest first.

    Empty list is a valid response (freshly registered container
    with no user-created sessions yet).
    """
    async with engine.connect() as conn:
        rows = (
            await conn.execute(
                sa.text(
                    "SELECT session_id, container_id, name, kind, "
                    "created_at, updated_at FROM sessions "
                    "WHERE container_id = :cid "
                    "ORDER BY created_at ASC, session_id ASC"
                ),
                {"cid": container_id},
            )
        ).mappings().all()
    return [_row_to_model(r) for r in rows]


async def rename_session(
    engine: AsyncEngine,
    *,
    session_id: str,
    name: str,
) -> NamedSession:
    """Update the name + bump ``updated_at``. Raises
    ``SessionNotFound`` when ``session_id`` doesn't exist."""
    now = datetime.utcnow()
    async with engine.begin() as conn:
        result = await conn.execute(
            sa.text(
                "UPDATE sessions SET name = :name, updated_at = :now "
                "WHERE session_id = :sid"
            ),
            {"name": name, "now": now, "sid": session_id},
        )
        if result.rowcount == 0:
            raise SessionNotFound(session_id)
        row = (
            await conn.execute(
                sa.text(
                    "SELECT session_id, container_id, name, kind, "
                    "created_at, updated_at FROM sessions "
                    "WHERE session_id = :sid"
                ),
                {"sid": session_id},
            )
        ).mappings().one()
    return _row_to_model(row)


async def delete_session(
    engine: AsyncEngine,
    *,
    session_id: str,
) -> None:
    """Remove ``session_id`` if present. Idempotent — calling for a
    nonexistent id is a silent no-op (matches ``DELETE`` REST
    semantics)."""
    async with engine.begin() as conn:
        await conn.execute(
            sa.text("DELETE FROM sessions WHERE session_id = :sid"),
            {"sid": session_id},
        )
```

- [ ] **Step 4: Run — passing.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_named_sessions_service.py -v
```

Expected: 8 passing.

- [ ] **Step 5: Full hub suite.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest -q
```

Expected: 319 + 8 = 327 passing.

- [ ] **Step 6: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/named_sessions.py hub/tests/test_named_sessions_service.py
git commit -m "feat(m26): named_sessions service layer (create/list/rename/delete)"
```

---

## Task 4: Router — `named_sessions.py` (TDD)

**Files:**

- Create: `hub/routers/named_sessions.py`
- Create: `hub/tests/test_named_sessions_endpoint.py`

- [ ] **Step 1: Write failing integration tests.**

Create `hub/tests/test_named_sessions_endpoint.py`:

```python
"""Integration tests for the named-sessions router (M26)."""

from __future__ import annotations

from pathlib import Path

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings
from hub.db.migrations_runner import apply_migrations_sync


@pytest_asyncio.fixture
async def client(tmp_path: Path) -> AsyncClient:
    from hub.main import app
    from hub.services.registry import Registry

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
    # Seed a container.
    sync_engine = sa.create_engine(f"sqlite:///{db_path}")
    with sync_engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO containers "
                "(workspace_folder, project_type, project_name, "
                "project_description, container_status, agent_status, "
                "agent_port, has_gpu, has_claude_cli, agent_expected) "
                "VALUES ('/w','base','demo','','running','idle',0,0,0,1)",
            ),
        )

    reg = Registry(db_path=db_path)
    await reg.open()

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.registry = reg

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c

    await reg.close()


AUTH = {"Authorization": "Bearer test-token"}


@pytest.mark.asyncio
async def test_list_empty_container(client: AsyncClient) -> None:
    resp = await client.get("/api/containers/1/named-sessions", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_create_and_list_round_trip(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "Main", "kind": "shell"},
    )
    assert resp.status_code == 200
    created = resp.json()
    assert created["name"] == "Main"
    assert created["kind"] == "shell"
    assert created["container_id"] == 1
    assert len(created["session_id"]) == 32

    resp = await client.get("/api/containers/1/named-sessions", headers=AUTH)
    assert resp.status_code == 200
    listed = resp.json()
    assert len(listed) == 1
    assert listed[0]["session_id"] == created["session_id"]


@pytest.mark.asyncio
async def test_patch_renames(client: AsyncClient) -> None:
    create = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "orig"},
    )
    sid = create.json()["session_id"]
    resp = await client.patch(
        f"/api/named-sessions/{sid}",
        headers=AUTH,
        json={"name": "renamed"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "renamed"


@pytest.mark.asyncio
async def test_delete_removes_row(client: AsyncClient) -> None:
    create = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "bye"},
    )
    sid = create.json()["session_id"]
    resp = await client.delete(f"/api/named-sessions/{sid}", headers=AUTH)
    assert resp.status_code == 204
    listed = await client.get("/api/containers/1/named-sessions", headers=AUTH)
    assert listed.json() == []


@pytest.mark.asyncio
async def test_delete_missing_is_idempotent(client: AsyncClient) -> None:
    resp = await client.delete("/api/named-sessions/nope", headers=AUTH)
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_unauthorized_list() -> None:
    # No Authorization header → 401 regardless of path.
    from hub.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.get("/api/containers/1/named-sessions")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_create_404_unknown_container(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/containers/999/named-sessions",
        headers=AUTH,
        json={"name": "x"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_patch_404_unknown_session(client: AsyncClient) -> None:
    resp = await client.patch(
        "/api/named-sessions/nope",
        headers=AUTH,
        json={"name": "x"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_create_422_on_empty_name(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": ""},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_422_on_long_name(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "a" * 65},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_422_on_bad_kind(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "x", "kind": "weird"},
    )
    assert resp.status_code == 422
```

- [ ] **Step 2: Run — fails.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_named_sessions_endpoint.py -v
```

Expected: 404s on every path (router not registered).

- [ ] **Step 3: Implement the router.**

Create `hub/routers/named_sessions.py`:

```python
"""CRUD router for persistent named sessions (M26).

Two path shapes:

- Container-scoped list + create at
  ``/api/containers/{record_id}/named-sessions``
- Session-scoped rename + delete at
  ``/api/named-sessions/{session_id}``

The split mirrors REST convention (GET/POST are collection ops;
PATCH/DELETE are on the individual resource) and keeps the
frontend's ``renameNamedSession`` / ``deleteNamedSession`` wrappers
container-agnostic.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from hub.models.schemas import NamedSession, NamedSessionCreate, NamedSessionPatch
from hub.services.named_sessions import (
    SessionNotFound,
    create_session,
    delete_session,
    list_sessions,
    rename_session,
)

router = APIRouter(tags=["named-sessions"])


async def _lookup_container_record(registry, record_id: int) -> None:
    """Verify the container exists (404 otherwise). We don't need its
    fields — just the existence check before hitting the sessions
    table."""
    try:
        await registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container record {record_id} not found")


@router.get(
    "/api/containers/{record_id}/named-sessions",
    response_model=list[NamedSession],
)
async def list_named_sessions(
    record_id: int, request: Request
) -> list[NamedSession]:
    """List all persistent sessions for a container, oldest first.

    Empty list is a valid response.
    """
    registry = request.app.state.registry
    await _lookup_container_record(registry, record_id)
    return await list_sessions(registry.engine, container_id=record_id)


@router.post(
    "/api/containers/{record_id}/named-sessions",
    response_model=NamedSession,
)
async def create_named_session_endpoint(
    record_id: int, request: Request, body: NamedSessionCreate
) -> NamedSession:
    """Create a new session row. Server generates ``session_id``."""
    registry = request.app.state.registry
    await _lookup_container_record(registry, record_id)
    return await create_session(
        registry.engine,
        container_id=record_id,
        name=body.name,
        kind=body.kind,
    )


@router.patch(
    "/api/named-sessions/{session_id}",
    response_model=NamedSession,
)
async def rename_named_session_endpoint(
    session_id: str, request: Request, body: NamedSessionPatch
) -> NamedSession:
    """Update the name + bump ``updated_at``."""
    registry = request.app.state.registry
    try:
        return await rename_session(
            registry.engine,
            session_id=session_id,
            name=body.name,
        )
    except SessionNotFound:
        raise HTTPException(404, f"Session {session_id} not found")


@router.delete("/api/named-sessions/{session_id}", status_code=204)
async def delete_named_session_endpoint(
    session_id: str, request: Request
) -> None:
    """Delete a session. Idempotent — 204 even when the row didn't exist."""
    registry = request.app.state.registry
    await delete_session(registry.engine, session_id=session_id)
```

- [ ] **Step 4: Register the router in `hub/main.py`.**

Find the block where existing routers are included (search for `include_router`). Add:

```python
from hub.routers.named_sessions import router as named_sessions_router
...
app.include_router(named_sessions_router)
```

Match the style of the existing imports — they may use a pattern like `from hub.routers import sessions` with later `app.include_router(sessions.router)`. Follow whichever the file already uses.

- [ ] **Step 5: Run — passing.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest tests/test_named_sessions_endpoint.py -v
```

Expected: 11 passing.

- [ ] **Step 6: Full hub suite.**

```bash
cd /home/gnava/repos/honeycomb/hub && uv run pytest -q
```

Expected: 327 + 11 = 338 passing.

- [ ] **Step 7: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add hub/routers/named_sessions.py hub/main.py hub/tests/test_named_sessions_endpoint.py
git commit -m "feat(m26): /named-sessions CRUD router with 11 integration tests"
```

---

## Task 5: Dashboard — API wrappers + TS types

**Files:**

- Modify: `dashboard/src/lib/types.ts`
- Modify: `dashboard/src/lib/api.ts`

- [ ] **Step 1: Add types to `dashboard/src/lib/types.ts`.**

Append near the existing container-session types:

```ts
// M26 — persistent named sessions.

export type SessionKind = "shell" | "claude";

export interface NamedSession {
  session_id: string;
  container_id: number;
  name: string;
  kind: SessionKind;
  created_at: string;
  updated_at: string;
}

export interface NamedSessionCreate {
  name: string;
  kind?: SessionKind;
}
```

- [ ] **Step 2: Add four wrappers to `dashboard/src/lib/api.ts`.**

Ensure the types are in the top import block from `./types`. Near the existing `listContainerSessions` export (which stays untouched), add:

```ts
export const listNamedSessions = (id: number) =>
  request<NamedSession[]>(`/containers/${id}/named-sessions`);

export const createNamedSession = (id: number, body: NamedSessionCreate) =>
  request<NamedSession>(`/containers/${id}/named-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const renameNamedSession = (sessionId: string, name: string) =>
  request<NamedSession>(`/named-sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

export const deleteNamedSession = (sessionId: string) =>
  request<void>(`/named-sessions/${sessionId}`, { method: "DELETE" });
```

- [ ] **Step 3: Typecheck.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 4: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/lib/api.ts dashboard/src/lib/types.ts
git commit -m "feat(m26): NamedSession types + four API wrappers"
```

---

## Task 6: `useSessions` hook (TDD)

**Files:**

- Create: `dashboard/src/hooks/useSessions.ts`
- Create: `dashboard/src/hooks/__tests__/useSessions.test.tsx`

- [ ] **Step 1: Write failing tests.**

Create `dashboard/src/hooks/__tests__/useSessions.test.tsx`:

```tsx
/** useSessions tests (M26).
 *
 * Mocks the four API wrappers so the hook's cache behaviour +
 * optimistic mutations are exercised without network.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSessions } from "../useSessions";

const mockList = vi.hoisted(() => vi.fn<(id: number) => Promise<unknown>>());
const mockCreate = vi.hoisted(() => vi.fn<(id: number, body: unknown) => Promise<unknown>>());
const mockRename = vi.hoisted(() => vi.fn<(sid: string, name: string) => Promise<unknown>>());
const mockDelete = vi.hoisted(() => vi.fn<(sid: string) => Promise<void>>());

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    listNamedSessions: mockList,
    createNamedSession: mockCreate,
    renameNamedSession: mockRename,
    deleteNamedSession: mockDelete,
  };
});

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function session(id: string, name = "Main", kind = "shell") {
  return {
    session_id: id,
    container_id: 1,
    name,
    kind,
    created_at: "2026-04-20T00:00:00",
    updated_at: "2026-04-20T00:00:00",
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockCreate.mockReset();
  mockRename.mockReset();
  mockDelete.mockReset();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: false } },
  });
});
afterEach(() => {
  qc.clear();
  vi.restoreAllMocks();
});

describe("useSessions", () => {
  it("returns empty while containerId is null", () => {
    const { result } = renderHook(() => useSessions(null), { wrapper });
    expect(result.current.sessions).toEqual([]);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("fetches sessions when containerId is set", async () => {
    mockList.mockResolvedValue([session("a"), session("b", "Claude", "claude")]);
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(2));
    expect(result.current.sessions[0].session_id).toBe("a");
    expect(result.current.sessions[1].kind).toBe("claude");
  });

  it("create appends optimistically and replaces with server row on success", async () => {
    mockList.mockResolvedValue([session("a")]);
    let resolveCreate!: (v: unknown) => void;
    mockCreate.mockImplementation(
      () =>
        new Promise((res) => {
          resolveCreate = res;
        }),
    );
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(1));

    let newId = "";
    await act(async () => {
      const p = result.current.create({ name: "pending", kind: "shell" });
      // Optimistic row should be visible before resolve.
      await waitFor(() => expect(result.current.sessions.length).toBe(2));
      resolveCreate(session("server-id", "pending", "shell"));
      const resolved = await p;
      newId = resolved.session_id;
    });

    await waitFor(() => {
      const last = result.current.sessions[result.current.sessions.length - 1];
      expect(last.session_id).toBe("server-id");
    });
    expect(newId).toBe("server-id");
  });

  it("rename patches the cached row", async () => {
    mockList.mockResolvedValue([session("a", "orig")]);
    mockRename.mockResolvedValue(session("a", "new"));
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(1));
    await act(async () => {
      await result.current.rename("a", "new");
    });
    await waitFor(() => expect(result.current.sessions[0].name).toBe("new"));
  });

  it("close removes the row from cache", async () => {
    mockList.mockResolvedValue([session("a"), session("b")]);
    mockDelete.mockResolvedValue(undefined);
    const { result } = renderHook(() => useSessions(1), { wrapper });
    await waitFor(() => expect(result.current.sessions.length).toBe(2));
    await act(async () => {
      await result.current.close("a");
    });
    await waitFor(() => expect(result.current.sessions.length).toBe(1));
    expect(result.current.sessions[0].session_id).toBe("b");
  });
});
```

- [ ] **Step 2: Run — fails.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useSessions.test.tsx
```

Expected: `Cannot find module '../useSessions'`.

- [ ] **Step 3: Implement the hook.**

Create `dashboard/src/hooks/useSessions.ts`:

```tsx
/** Persistent named sessions for a container (M26).
 *
 * Replaces the pre-M26 localStorage-backed session registry. The
 * hub owns the truth; reloads and new devices pull the same list.
 *
 * Mutations are optimistic: ``create`` appends a pending row, then
 * swaps in the server-assigned ``session_id`` once the POST
 * resolves. ``rename`` and ``close`` patch the cache immediately
 * and roll back on error.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  createNamedSession,
  deleteNamedSession,
  listNamedSessions,
  renameNamedSession,
} from "../lib/api";
import type { NamedSession, NamedSessionCreate, SessionKind } from "../lib/types";

export interface UseSessionsResult {
  sessions: NamedSession[];
  isLoading: boolean;
  error: unknown;
  create: (input: NamedSessionCreate) => Promise<NamedSession>;
  rename: (sessionId: string, name: string) => Promise<void>;
  close: (sessionId: string) => Promise<void>;
}

function provisional(containerId: number, name: string, kind: SessionKind): NamedSession {
  const now = new Date().toISOString();
  return {
    session_id: `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    container_id: containerId,
    name,
    kind,
    created_at: now,
    updated_at: now,
  };
}

export function useSessions(containerId: number | null): UseSessionsResult {
  const qc = useQueryClient();
  const queryKey = ["named-sessions", containerId] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => listNamedSessions(containerId as number),
    enabled: containerId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const createMutation = useMutation({
    mutationFn: (input: NamedSessionCreate) => createNamedSession(containerId as number, input),
    onMutate: async (input) => {
      if (containerId === null) return { previous: [] as NamedSession[], pending: null };
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<NamedSession[]>(queryKey) ?? [];
      const pending = provisional(containerId, input.name, input.kind ?? "shell");
      qc.setQueryData<NamedSession[]>(queryKey, [...previous, pending]);
      return { previous, pending };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) qc.setQueryData(queryKey, ctx.previous);
    },
    onSuccess: (server, _vars, ctx) => {
      // Swap the pending row for the server row. If no pending row
      // (containerId was null), just append.
      qc.setQueryData<NamedSession[]>(queryKey, (prev) => {
        const base = prev ?? [];
        if (ctx?.pending) {
          return base.map((s) => (s.session_id === ctx.pending!.session_id ? server : s));
        }
        return [...base, server];
      });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey });
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ sessionId, name }: { sessionId: string; name: string }) =>
      renameNamedSession(sessionId, name),
    onMutate: async ({ sessionId, name }) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<NamedSession[]>(queryKey) ?? [];
      qc.setQueryData<NamedSession[]>(
        queryKey,
        previous.map((s) => (s.session_id === sessionId ? { ...s, name } : s)),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) qc.setQueryData(queryKey, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey });
    },
  });

  const closeMutation = useMutation({
    mutationFn: (sessionId: string) => deleteNamedSession(sessionId),
    onMutate: async (sessionId) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<NamedSession[]>(queryKey) ?? [];
      qc.setQueryData<NamedSession[]>(
        queryKey,
        previous.filter((s) => s.session_id !== sessionId),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) qc.setQueryData(queryKey, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey });
    },
  });

  const create = useCallback(
    (input: NamedSessionCreate) => createMutation.mutateAsync(input),
    [createMutation],
  );
  const rename = useCallback(
    async (sessionId: string, name: string) => {
      await renameMutation.mutateAsync({ sessionId, name });
    },
    [renameMutation],
  );
  const close = useCallback(
    async (sessionId: string) => {
      await closeMutation.mutateAsync(sessionId);
    },
    [closeMutation],
  );

  return {
    sessions: query.data ?? [],
    isLoading: query.isFetching,
    error: query.error,
    create,
    rename,
    close,
  };
}
```

- [ ] **Step 4: Run — passing.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useSessions.test.tsx
```

Expected: 5 passing.

- [ ] **Step 5: Typecheck + full vitest.**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: 0 errors; all tests passing.

- [ ] **Step 6: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/hooks/useSessions.ts dashboard/src/hooks/__tests__/useSessions.test.tsx
git commit -m "feat(m26): useSessions hook with optimistic create/rename/close"
```

---

## Task 7: One-shot localStorage migration (TDD)

**Files:**

- Create: `dashboard/src/lib/migrateSessions.ts`
- Create: `dashboard/src/lib/__tests__/migrateSessions.test.ts`

- [ ] **Step 1: Create the vitest directory + failing tests.**

`dashboard/src/lib/__tests__/` may not exist yet. `mkdir -p` it (the vitest config picks up tests via glob so no config change is needed).

Create `dashboard/src/lib/__tests__/migrateSessions.test.ts`:

```ts
/** M26 — client-side migration of legacy localStorage session state.
 *
 * Exercises the pure data-shuffling logic: the migration POSTs each
 * session, builds oldId→newId map, rewrites dependent keys, wipes
 * pty-label sessionStorage, clears the source key, and sets the
 * idempotency guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSessionMigration } from "../migrateSessions";

const mockCreate = vi.hoisted(() => vi.fn<(id: number, body: unknown) => Promise<unknown>>());

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, createNamedSession: mockCreate };
});

beforeEach(() => {
  mockCreate.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function serverRow(sid: string, name = "Main", kind = "shell") {
  return {
    session_id: sid,
    container_id: 1,
    name,
    kind,
    created_at: "2026-04-20T00:00:00",
    updated_at: "2026-04-20T00:00:00",
  };
}

describe("runSessionMigration", () => {
  it("is a no-op when the guard key is already set", async () => {
    localStorage.setItem("hive:layout:sessionsMigratedAt", "2026-04-20");
    const result = await runSessionMigration();
    expect(result.migrated).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("is a no-op when no legacy sessions exist", async () => {
    const result = await runSessionMigration();
    expect(result.migrated).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(localStorage.getItem("hive:layout:sessionsMigratedAt")).toBeTruthy();
  });

  it("migrates a single-container localStorage snapshot end-to-end", async () => {
    localStorage.setItem(
      "hive:layout:sessions",
      JSON.stringify({
        "7": [
          { id: "default", name: "Main" },
          { id: "s-abc", name: "Build" },
        ],
      }),
    );
    localStorage.setItem("hive:layout:activeSession", JSON.stringify({ "7": "s-abc" }));
    localStorage.setItem("hive:terminal-last-kind:7:s-abc", "claude");
    sessionStorage.setItem("hive:pty:label:7:default", "default-abcdef01");
    sessionStorage.setItem("hive:pty:label:7:s-abc", "s-abc-deadbeef");

    mockCreate.mockImplementation(async (_cid, body) => {
      const b = body as { name: string; kind?: string };
      return serverRow(`srv-${b.name.toLowerCase()}`, b.name, b.kind ?? "shell");
    });

    const result = await runSessionMigration();

    expect(result.migrated).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // Kind pulled from hive:terminal-last-kind:*.
    const calledWith = mockCreate.mock.calls.map((c) => c[1]);
    expect(calledWith).toContainEqual({ name: "Main", kind: "shell" });
    expect(calledWith).toContainEqual({ name: "Build", kind: "claude" });

    // activeSession rewritten: s-abc → srv-build.
    const active = JSON.parse(localStorage.getItem("hive:layout:activeSession") ?? "{}");
    expect(active).toEqual({ "7": "srv-build" });

    // terminal-last-kind moved to the new id.
    expect(localStorage.getItem("hive:terminal-last-kind:7:s-abc")).toBeNull();
    expect(localStorage.getItem("hive:terminal-last-kind:7:srv-build")).toBe("claude");

    // pty-label sessionStorage wiped.
    expect(sessionStorage.getItem("hive:pty:label:7:default")).toBeNull();
    expect(sessionStorage.getItem("hive:pty:label:7:s-abc")).toBeNull();

    // Source key cleared; guard set.
    expect(localStorage.getItem("hive:layout:sessions")).toBeNull();
    expect(localStorage.getItem("hive:layout:sessionsMigratedAt")).toBeTruthy();
  });

  it("skips entries whose POST 404s and continues with the rest", async () => {
    localStorage.setItem(
      "hive:layout:sessions",
      JSON.stringify({
        "999": [{ id: "ghost", name: "Ghost" }],
        "7": [{ id: "live", name: "Live" }],
      }),
    );

    mockCreate.mockImplementation(async (cid, body) => {
      if (cid === 999) {
        const err = Object.assign(new Error("404: not found"), { status: 404 });
        throw err;
      }
      const b = body as { name: string };
      return serverRow(`srv-${b.name.toLowerCase()}`, b.name);
    });

    const result = await runSessionMigration();

    expect(result.migrated).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].containerId).toBe("999");
    expect(result.skipped[0].oldId).toBe("ghost");
  });
});
```

- [ ] **Step 2: Run — fails.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/lib/__tests__/migrateSessions.test.ts
```

Expected: `Cannot find module '../migrateSessions'`.

- [ ] **Step 3: Implement the migration.**

Create `dashboard/src/lib/migrateSessions.ts`:

```ts
/** One-shot migration of localStorage session state to the hub (M26).
 *
 * The pre-M26 dashboard stored session names under
 * ``hive:layout:sessions`` (Record<containerId, SessionInfo[]>). This
 * function POSTs every entry to ``/api/containers/{id}/named-sessions``,
 * captures the oldId→newId map, rewrites dependent keys, wipes PTY
 * sessionStorage labels (users get fresh terminals — accepted
 * trade-off), and sets a guard key so re-runs no-op.
 *
 * Idempotency: the guard key (``hive:layout:sessionsMigratedAt``) is
 * set ONLY after a full pass. A mid-run auth failure leaves
 * localStorage untouched; the next run retries from scratch.
 * Partial failure (e.g., half the POSTs succeed before a 401) could
 * produce duplicate rows on retry — acceptable given the rarity
 * of mid-migration auth failure in a single-user local tool.
 */

import { createNamedSession } from "./api";
import type { NamedSessionCreate, SessionKind } from "./types";

const LS_SOURCE = "hive:layout:sessions";
const LS_ACTIVE = "hive:layout:activeSession";
const LS_GUARD = "hive:layout:sessionsMigratedAt";
const LS_KIND_PREFIX = "hive:terminal-last-kind:";
const SS_PTY_PREFIX = "hive:pty:label:";

export interface MigrationSkip {
  containerId: string;
  oldId: string;
  reason: string;
}

export interface MigrationResult {
  migrated: number;
  skipped: MigrationSkip[];
}

interface LegacySession {
  id: string;
  name: string;
}

function readJson<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readKind(containerId: string, oldId: string): SessionKind {
  const raw = localStorage.getItem(`${LS_KIND_PREFIX}${containerId}:${oldId}`);
  return raw === "claude" ? "claude" : "shell";
}

function moveKind(containerId: string, oldId: string, newId: string): void {
  const key = `${LS_KIND_PREFIX}${containerId}:${oldId}`;
  const value = localStorage.getItem(key);
  if (value !== null) {
    localStorage.setItem(`${LS_KIND_PREFIX}${containerId}:${newId}`, value);
    localStorage.removeItem(key);
  }
}

function wipePtyLabel(containerId: string, oldId: string): void {
  sessionStorage.removeItem(`${SS_PTY_PREFIX}${containerId}:${oldId}`);
}

export async function runSessionMigration(): Promise<MigrationResult> {
  // Idempotency guard — set once per successful migration.
  if (localStorage.getItem(LS_GUARD) !== null) {
    return { migrated: 0, skipped: [] };
  }

  const legacy = readJson<Record<string, LegacySession[]>>(LS_SOURCE);
  if (!legacy || Object.keys(legacy).length === 0) {
    localStorage.setItem(LS_GUARD, new Date().toISOString());
    return { migrated: 0, skipped: [] };
  }

  const active = readJson<Record<string, string>>(LS_ACTIVE) ?? {};
  const idMap: Record<string, Record<string, string>> = {}; // containerId → {oldId: newId}
  const skipped: MigrationSkip[] = [];
  let migrated = 0;

  for (const [containerIdStr, sessions] of Object.entries(legacy)) {
    const containerId = Number(containerIdStr);
    if (!Number.isFinite(containerId)) continue;
    idMap[containerIdStr] = {};
    for (const entry of sessions) {
      const kind = readKind(containerIdStr, entry.id);
      const body: NamedSessionCreate = { name: entry.name, kind };
      try {
        const row = await createNamedSession(containerId, body);
        idMap[containerIdStr][entry.id] = row.session_id;
        migrated += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err ?? "unknown");
        skipped.push({
          containerId: containerIdStr,
          oldId: entry.id,
          reason,
        });
      }
    }
  }

  // Rewrite hive:layout:activeSession: map old → new; drop unmapped.
  const nextActive: Record<string, string> = {};
  for (const [containerIdStr, oldId] of Object.entries(active)) {
    const newId = idMap[containerIdStr]?.[oldId];
    if (newId) nextActive[containerIdStr] = newId;
  }
  localStorage.setItem(LS_ACTIVE, JSON.stringify(nextActive));

  // Move terminal-last-kind keys to the new ids; wipe pty-label SS.
  for (const [containerIdStr, map] of Object.entries(idMap)) {
    for (const [oldId, newId] of Object.entries(map)) {
      moveKind(containerIdStr, oldId, newId);
      wipePtyLabel(containerIdStr, oldId);
    }
  }

  localStorage.removeItem(LS_SOURCE);
  localStorage.setItem(LS_GUARD, new Date().toISOString());

  return { migrated, skipped };
}
```

- [ ] **Step 4: Run — passing.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/lib/__tests__/migrateSessions.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Typecheck + full vitest.**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: 0 errors; all tests passing.

- [ ] **Step 6: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/lib/migrateSessions.ts dashboard/src/lib/__tests__/migrateSessions.test.ts
git commit -m "feat(m26): runSessionMigration — one-shot localStorage → hub"
```

---

## Task 8: `App.tsx` — swap localStorage readers for `useSessions`

**Files:**

- Modify: `dashboard/src/App.tsx`

This is the largest edit in M26. Changes:

1. Remove legacy `LS_SESSIONS` / `LS_ACTIVE_SESSION` constants + validators + `useLocalStorage` readers.
2. Add `useSessions(active?.id ?? null)`.
3. Keep a smaller `LS_ACTIVE_SESSION_ID = "hive:layout:activeSessionByContainer"` localStorage for the active-session id (client state; new shape = `Record<containerId, sessionId>`, same as before but with server-provided ids).
4. Rewrite `newSession` / `renameSession` / `closeSession` / `focusSession` / `newClaudeSession` to delegate to the hook.
5. Add a first-empty-state guard: if the active container has zero sessions after hook resolves, auto-create `{name: "Main", kind: "shell"}`.
6. Wire `runSessionMigration()` into a mount-only `useEffect`.

- [ ] **Step 1: Read `dashboard/src/App.tsx` to locate the existing section.**

```bash
grep -n "LS_SESSIONS\|LS_ACTIVE_SESSION\|sessionsByContainer\|activeSessionByContainer\|newSession\|renameSession\|closeSession\|focusSession\|newClaudeSession" /home/gnava/repos/honeycomb/dashboard/src/App.tsx
```

Capture line numbers so the edits below land in the right place.

- [ ] **Step 2: Remove legacy constants + validators.**

Delete:

```tsx
const LS_SESSIONS = "hive:layout:sessions"; // M16 — per-container nested sessions
const LS_ACTIVE_SESSION = "hive:layout:activeSession"; // M16
```

```tsx
type SessionsByContainer = Record<string, SessionInfo[]>;

function isSessionsByContainer(v: unknown): v is SessionsByContainer { ... }
function isActiveSessionMap(v: unknown): v is Record<string, string> { ... }
```

Replace with:

```tsx
// M26 — active-session id per container (client-only; the authoritative
// session list + names come from /api/containers/{id}/named-sessions).
const LS_ACTIVE_SESSION_ID = "hive:layout:activeSessionByContainer";

function isActiveSessionIdMap(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((s) => typeof s === "string");
}
```

- [ ] **Step 3: Update imports at the top of `App.tsx`.**

Remove (if present):

```tsx
import { useLocalStorage } from "./hooks/useLocalStorage"; // keep this — still used for LS_ACTIVE_SESSION_ID
```

Add:

```tsx
import { runSessionMigration } from "./lib/migrateSessions";
import { useSessions } from "./hooks/useSessions";
import type { NamedSession } from "./lib/types";
```

`SessionSubTabs` takes `SessionInfo[]` with `{id, name}` — a `NamedSession` has those plus extra fields. The existing `SessionInfo` type in `components/SessionSubTabs.tsx` is still compatible (TypeScript treats `NamedSession` as assignable via structural subtyping because it has `id: string` and `name: string`). But `NamedSession.id` doesn't exist — the field is `session_id`. Two options:

- **Option A (recommended).** At the call site in `App.tsx`, map `NamedSession[]` → `{id: session.session_id, name: session.name}[]` before passing to `<SessionSubTabs>`. Keeps `SessionSubTabs` unchanged.
- **Option B.** Widen `SessionInfo` in `SessionSubTabs.tsx` to `{id: string, name: string, kind?: SessionKind}`. More invasive.

Use Option A — map at the call site.

- [ ] **Step 4: Replace the session state derivation.**

Locate the block that computes `activeSessions` and `activeSessionId`:

```tsx
const activeSessions: SessionInfo[] = useMemo(() => {
  if (active === undefined) return [];
  const stored = sessionsByContainer[String(active.id)] ?? [];
  if (stored.length > 0) return stored;
  return [{ id: "default", name: "Main" }];
}, [active, sessionsByContainer]);

const activeSessionId: string = useMemo(() => {
  if (active === undefined) return "default";
  const stored = activeSessionByContainer[String(active.id)];
  if (stored && activeSessions.some((s) => s.id === stored)) return stored;
  return activeSessions[0]?.id ?? "default";
}, [active, activeSessionByContainer, activeSessions]);
```

Replace with:

```tsx
// M26 — sessions come from the hub.
const {
  sessions: namedSessions,
  create: createSessionApi,
  rename: renameSessionApi,
  close: closeSessionApi,
} = useSessions(active?.id ?? null);

const [activeSessionByContainer, setActiveSessionByContainer] = useLocalStorage<
  Record<string, string>
>(LS_ACTIVE_SESSION_ID, {}, { validate: isActiveSessionIdMap });

// Map to SessionInfo for SessionSubTabs (it expects {id, name}).
const activeSessions: SessionInfo[] = useMemo(
  () =>
    active === undefined ? [] : namedSessions.map((s) => ({ id: s.session_id, name: s.name })),
  [active, namedSessions],
);

const activeSessionId: string = useMemo(() => {
  if (active === undefined) return "";
  const stored = activeSessionByContainer[String(active.id)];
  if (stored && activeSessions.some((s) => s.id === stored)) return stored;
  return activeSessions[0]?.id ?? "";
}, [active, activeSessionByContainer, activeSessions]);
```

- [ ] **Step 5: Auto-seed a default session when the hook returns empty.**

Add immediately after the above block:

```tsx
// M26 — first-load-empty guard: auto-create a default shell session
// so the tab strip never renders blank after migration.
const firstEmptyGuardRef = useRef(false);
useEffect(() => {
  if (active === undefined) return;
  if (namedSessions.length > 0) return;
  if (firstEmptyGuardRef.current) return;
  firstEmptyGuardRef.current = true;
  void createSessionApi({ name: "Main", kind: "shell" });
}, [active, namedSessions, createSessionApi]);
useEffect(() => {
  // Reset the guard when the active container changes.
  firstEmptyGuardRef.current = false;
}, [active?.id]);
```

Make sure `useRef` is in the React imports at the top of `App.tsx`.

- [ ] **Step 6: Rewrite the session handler callbacks.**

Delete the existing `newSession`, `renameSession`, `closeSession`, `focusSession`, `newClaudeSession`, and `reorderSession` declarations. Replace with:

```tsx
const focusSession = useCallback(
  (sessionId: string) => {
    if (active === undefined) return;
    setActiveSessionByContainer((prev) => ({
      ...prev,
      [String(active.id)]: sessionId,
    }));
  },
  [active, setActiveSessionByContainer],
);

const newSession = useCallback(async () => {
  if (active === undefined) return;
  const rawName = window.prompt(
    `Name for the new session on ${active.project_name}:`,
    `session ${namedSessions.length + 1}`,
  );
  if (rawName === null) return;
  const name = rawName.trim() || `session ${namedSessions.length + 1}`;
  const created = await createSessionApi({ name, kind: "shell" });
  focusSession(created.session_id);
}, [active, namedSessions.length, createSessionApi, focusSession]);

const newClaudeSession = useCallback(
  async (id: number) => {
    localStorage.setItem(`${LS_LAST_KIND_PREFIX}${id}`, "claude");
    setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveTabId(id);
    // Create a Claude session immediately for the newly focused container.
    const target = containers.find((c) => c.id === id);
    if (target === undefined) return;
    const created = await createNamedSession(id, { name: "Claude", kind: "claude" });
    setActiveSessionByContainer((prev) => ({
      ...prev,
      [String(id)]: created.session_id,
    }));
  },
  [containers, setOpenTabs, setActiveTabId, setActiveSessionByContainer],
);

const renameSession = useCallback(
  async (sessionId: string, nextName: string) => {
    await renameSessionApi(sessionId, nextName);
  },
  [renameSessionApi],
);

const closeSession = useCallback(
  async (sessionId: string) => {
    if (namedSessions.length <= 1) return; // keep at least one
    await closeSessionApi(sessionId);
    if (active === undefined) return;
    // If the closed session was active, pivot to the first remaining.
    if (activeSessionByContainer[String(active.id)] === sessionId) {
      const remaining = namedSessions.filter((s) => s.session_id !== sessionId);
      setActiveSessionByContainer((prev) => ({
        ...prev,
        [String(active.id)]: remaining[0]?.session_id ?? "",
      }));
    }
  },
  [active, namedSessions, activeSessionByContainer, closeSessionApi, setActiveSessionByContainer],
);

// M26: reorder is deferred to a future milestone. For now, no-op.
const reorderSession = useCallback(() => {
  /* M28 */
}, []);
```

Import `createNamedSession` from `./lib/api` in the imports block (for `newClaudeSession`).

- [ ] **Step 7: Wire the migration hook.**

Near the top of `App()` (before any session-dependent render), add:

```tsx
// M26 — one-shot migration from legacy localStorage to the hub.
// Idempotent via the guard key; this effect fires at most once
// per mount (React StrictMode double-runs effects; the guard
// makes the second call a no-op).
useEffect(() => {
  void runSessionMigration().then((result) => {
    if (result.migrated > 0) {
      console.info("[m26] migrated", result.migrated, "sessions");
    }
  });
}, []);
```

Ensure `runSessionMigration` is imported (Step 3).

- [ ] **Step 8: Typecheck + lint + full vitest.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx tsc --noEmit && npm run lint && npx vitest run
```

Expected: 0 TS errors; 0 lint errors; all tests passing.

- [ ] **Step 9: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/App.tsx
git commit -m "feat(m26): App.tsx swaps localStorage sessions for useSessions + migration"
```

---

## Task 9: Playwright e2e — named-sessions round trip

**Files:**

- Create: `dashboard/tests/e2e/named-sessions.spec.ts`

- [ ] **Step 1: Write the spec.**

Create `dashboard/tests/e2e/named-sessions.spec.ts`:

```ts
/** M26 — persistent named sessions end-to-end.
 *
 * Stubs /named-sessions to avoid a real hub. Asserts:
 *   - list populates the SessionSubTabs strip
 *   - creating a session adds a tab
 *   - renaming updates the tab label
 *   - deleting removes the tab
 *   - first-empty auto-creates a "Main" session
 *   - migration runs on first load when legacy localStorage is present
 */

import { expect, test } from "@playwright/test";

const TOKEN = "named-sessions-token";

const containerFixture = {
  id: 7,
  workspace_folder: "/w",
  project_type: "base",
  project_name: "demo",
  project_description: "",
  git_repo_url: null,
  container_id: "dead",
  container_status: "running",
  agent_status: "idle",
  agent_port: 0,
  has_gpu: false,
  has_claude_cli: false,
  claude_cli_checked_at: null,
  created_at: "2026-04-20",
  updated_at: "2026-04-20",
  agent_expected: false,
};

function mockJson(data: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  };
}

async function seedRoutes(
  context: import("@playwright/test").BrowserContext,
  namedSessions: unknown[],
) {
  await context.addInitScript(
    ([t, openTab, activeTab]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", openTab);
        window.localStorage.setItem("hive:layout:activeTab", activeTab);
        // Pre-mark the guard so auto-migration skips during this test.
        window.localStorage.setItem("hive:layout:sessionsMigratedAt", "2026-04-20T00:00:00");
      } catch {
        // ignore
      }
    },
    [TOKEN, "[7]", "7"],
  );

  await context.route("**/api/containers", (route) => route.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/7/workdir", (route) =>
    route.fulfill(mockJson({ path: "/w" })),
  );
  await context.route("**/api/gitops/prs**", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/gitops/repos**", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/problems**", (route) => route.fulfill(mockJson({ problems: [] })));
  await context.route("**/api/settings", (route) =>
    route.fulfill(
      mockJson({
        values: {
          log_level: "INFO",
          discover_roots: [],
          metrics_enabled: true,
          timeline_visible: false,
        },
        mutable_fields: ["log_level", "discover_roots", "metrics_enabled", "timeline_visible"],
      }),
    ),
  );
  await context.route("**/api/keybindings**", (route) => route.fulfill(mockJson({ bindings: {} })));
  await context.route("**/api/containers/7/sessions", (route) =>
    route.fulfill(mockJson({ sessions: [] })),
  );
  await context.route("**/api/containers/7/resources**", (route) => route.fulfill(mockJson(null)));
  await context.route("**/api/containers/7/fs/**", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/health**", (route) => route.fulfill(mockJson({ status: "ok" })));
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));

  await context.route("**/api/containers/7/named-sessions", (route) =>
    route.fulfill(mockJson(namedSessions)),
  );
}

test("renders existing sessions from the hub", async ({ context, page }) => {
  await seedRoutes(context, [
    {
      session_id: "abc",
      container_id: 7,
      name: "Main",
      kind: "shell",
      created_at: "2026-04-20T00:00:00",
      updated_at: "2026-04-20T00:00:00",
    },
    {
      session_id: "def",
      container_id: 7,
      name: "Claude",
      kind: "claude",
      created_at: "2026-04-20T00:00:01",
      updated_at: "2026-04-20T00:00:01",
    },
  ]);
  await page.goto("/");

  // Two tabs rendered.
  await expect(page.getByRole("tab", { name: /Main/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Claude/ })).toBeVisible();
});

test("first-empty container auto-creates a Main session", async ({ context, page }) => {
  await seedRoutes(context, []);
  // Capture POST body.
  const posts: unknown[] = [];
  await context.route("**/api/containers/7/named-sessions", async (route) => {
    if (route.request().method() === "POST") {
      posts.push(JSON.parse(route.request().postData() ?? "null"));
      await route.fulfill(
        mockJson({
          session_id: "auto",
          container_id: 7,
          name: "Main",
          kind: "shell",
          created_at: "2026-04-20T00:00:00",
          updated_at: "2026-04-20T00:00:00",
        }),
      );
    } else {
      await route.fulfill(mockJson([]));
    }
  });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: /Main/ })).toBeVisible();
  // The auto-seed POST fired with the expected body.
  expect(posts).toContainEqual({ name: "Main", kind: "shell" });
});
```

- [ ] **Step 2: Run the new spec.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test --reporter=line tests/e2e/named-sessions.spec.ts
```

Expected: 2 passing.

If the `"tab"` role assertion fails (SessionSubTabs may use a different role), adjust the selector to match the component's actual DOM. Common alternatives: `page.getByText(/Main/)` scoped to the tab strip container, or a `data-slot` / `data-testid` that already exists on the component.

- [ ] **Step 3: Run the full Playwright suite.**

```bash
npx playwright test --reporter=line
```

Expected: previous 16 + 2 new = 18 passing. If pre-existing specs now fail, the most likely cause is the new `useSessions` fetch firing in those specs without a stub. Add `context.route("**/api/containers/*/named-sessions", (route) => route.fulfill(mockJson([])))` to their `beforeEach` blocks.

- [ ] **Step 4: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/tests/e2e/named-sessions.spec.ts
# plus any e2e files you had to extend with the named-sessions stub
git commit -m "test(m26): Playwright — persistent named sessions round trip"
```

---

## Task 10: Prettier sweep + full verification

- [ ] **Step 1: Prettier-write the dashboard (CI drift workaround — memory entry).**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write .
```

- [ ] **Step 2: Typecheck + lint + full vitest.**

```bash
npx tsc --noEmit && npm run lint && npx vitest run
```

Expected: 0 TS errors; 0 lint errors; all tests passing.

- [ ] **Step 3: Full Playwright suite.**

```bash
npx playwright test --reporter=line
```

Expected: all green.

- [ ] **Step 4: Full hub pytest.**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest -q
```

Expected: all green (~338 passing).

- [ ] **Step 5: Commit any prettier changes.**

```bash
cd /home/gnava/repos/honeycomb
git status
git add -u
git commit -m "style(m26): prettier sweep before push" || true
```

---

## Task 11: Ship — merge, tag, push, CI watch

- [ ] **Step 1: Verify branch state.**

```bash
git log --oneline main..HEAD
```

Expected: ~11 M26 commits (spec + plan + feat + test + style).

- [ ] **Step 2: Merge to main with --no-ff.**

```bash
git checkout main && git pull --ff-only
git merge --no-ff m26-session-persistence -m "$(cat <<'EOF'
Merge M26: persistent named sessions (δ)

  * New sessions table via Alembic migration (session_id uuid4
    PK / container_id FK CASCADE / name / kind / created_at /
    updated_at).
  * Four-method CRUD router at /api/containers/{id}/named-sessions
    + /api/named-sessions/{id} with 11 integration tests.
  * Dashboard useSessions hook (optimistic create/rename/close
    with cache rollback on error).
  * One-shot runSessionMigration() moves every legacy
    localStorage session to the hub, rewrites activeSession +
    terminal-last-kind keys, wipes pty-label sessionStorage, and
    sets hive:layout:sessionsMigratedAt guard for idempotency.
  * App.tsx swaps the LS_SESSIONS / LS_ACTIVE_SESSION readers for
    the hook + a smaller active-session-id localStorage. First-
    empty container auto-creates a Main session.
  * Scope split from original M22 roadmap: ε Claude diff view is
    now queued as its own M27 milestone. See the spec for
    M28/M29/M30 follow-up tickets (reorder, metadata, WS push).

Full vitest + Playwright + hub pytest pass locally; prettier
sweep applied before push.
EOF
)"
```

- [ ] **Step 3: Tag.**

```bash
git tag -a v0.26-session-persistence -m "M26 — persistent named sessions (δ)"
```

- [ ] **Step 4: Push with tags.**

```bash
git push origin main --follow-tags
```

- [ ] **Step 5: Delete the merged branch.**

```bash
git branch -d m26-session-persistence
```

- [ ] **Step 6: Watch CI.**

```bash
export GH_TOKEN=$(grep -E '^GITHUB_TOKEN=' .env | cut -d= -f2-)
sleep 5
gh run list --branch main --limit 2
# find the in-progress run id
gh run watch <RUN_ID> --exit-status --interval 15
```

Expected: all 7 CI jobs green.

- [ ] **Step 7: Report result to user** with tag + CI summary.

---

## Notes / pitfalls for the implementing engineer

- **Alembic down_revision.** `1f4d0a7e5c21` is the M13 head at the time this plan was written. If another migration lands between now and Task 1, re-check `uv run alembic heads` and update the `down_revision` to match.
- **SQLAlchemy text queries vs ORM.** The service uses raw `sa.text()` queries to match the existing pattern in `hub/services/registry.py`. No ORM models declared. Intentional — the registry is a thin wrapper, not a rich domain layer.
- **FK CASCADE on SQLite.** Requires `PRAGMA foreign_keys=ON` per-connection. The registry's `create_async_engine` config should already enable this (Registry's existing tests rely on FK behaviour); if it doesn't, the CASCADE tests will fail and the fix is to add a `connect` event listener on the engine.
- **Idempotency risk on mid-migration failure.** If the POST loop in `runSessionMigration` fails half-way (e.g., 401), the guard key is NOT set — so the next load retries from scratch AND the already-migrated rows are duplicated. User can delete duplicates manually. Documented in the design spec's error-handling table; not worth mitigation code for an edge case on a single-user tool.
- **Pending-row IDs have a `pending-` prefix.** Chosen so they can never collide with a server UUID (which is 32-char hex). The cache swap in `createMutation.onSuccess` finds the pending row by id and replaces it.
- **Reorder is a no-op in M26.** `reorderSession` is still passed to `SessionSubTabs` but does nothing. Scheduled for M28.
- **PTY scrollback loss is expected.** Users see fresh terminals on first mount after migration because session IDs change and `hive:pty:label:*` sessionStorage is wiped. User explicitly accepted this during brainstorming.
- **Prettier hook-vs-CI drift.** Task 10 includes the mandatory `npx prettier --write .` before push. Without it, CI fails on style-only diffs (see memory entry).

## Self-review summary

**Spec coverage.**

| Spec section                          | Implementing task(s)              |
| ------------------------------------- | --------------------------------- |
| §1 Architecture diagram               | All tasks collectively            |
| §2 Alembic migration                  | Task 1                            |
| §2 Pydantic models                    | Task 2                            |
| §2 Service layer                      | Task 3                            |
| §2 Router                             | Task 4                            |
| §2 Tests — service                    | Task 3                            |
| §2 Tests — endpoint                   | Task 4                            |
| §2 Migration table test               | Task 1                            |
| §3 API wrappers + TS types            | Task 5                            |
| §3 useSessions hook                   | Task 6                            |
| §3 runSessionMigration                | Task 7                            |
| §3 App.tsx swap + migration hookup    | Task 8                            |
| §4 Error handling (empty / 404 / 422) | Tasks 3, 4, 6, 7                  |
| §5 Testing — Playwright               | Task 9                            |
| §6 Manual smoke                       | Documented in spec; not automated |

**Placeholder scan.** No TBD/TODO. Every step has concrete code or commands. One intentional pragma (`down_revision = "1f4d0a7e5c21"`) includes an explicit "check `alembic heads` before applying" note.

**Type consistency.** `session_id` (str/string), `container_id` (int/number), `name`, `kind` ("shell"|"claude"), `created_at`/`updated_at` (datetime/string) all consistent across Python (`NamedSession`, Alembic migration, service) and TypeScript (`NamedSession`, API wrappers, hook state). `SessionNotFound` / 404 mapping is uniform. The `LS_ACTIVE_SESSION_ID` key is used consistently in App.tsx + migration.
