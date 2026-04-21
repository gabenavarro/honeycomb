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
    # Column list derived from hub/db/migrations/versions/ (baseline + M13 agent_expected).
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


@pytest.mark.asyncio
async def test_create_session_returns_populated_row(engine) -> None:
    session = await create_session(engine, container_id=1, name="Main", kind="shell")
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
    # updated_at >= created_at (same call can match at low resolution).
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
