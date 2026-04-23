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
    patch_session,
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
    renamed = await patch_session(engine, session_id=session.session_id, name="new")
    assert renamed.name == "new"
    # updated_at >= created_at (same call can match at low resolution).
    assert renamed.updated_at >= session.created_at


@pytest.mark.asyncio
async def test_rename_missing_raises(engine) -> None:
    with pytest.raises(SessionNotFound):
        await patch_session(engine, session_id="nope", name="x")


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


# --- M28: position + patch_session ---


@pytest.mark.asyncio
async def test_create_assigns_sequential_positions(engine) -> None:
    from hub.services.named_sessions import create_session

    a = await create_session(engine, container_id=1, name="a", kind="shell")
    b = await create_session(engine, container_id=1, name="b", kind="shell")
    c = await create_session(engine, container_id=1, name="c", kind="shell")
    assert a.position == 1
    assert b.position == 2
    assert c.position == 3


@pytest.mark.asyncio
async def test_list_sessions_orders_by_position(engine) -> None:
    from hub.services.named_sessions import create_session, list_sessions

    a = await create_session(engine, container_id=1, name="a", kind="shell")
    b = await create_session(engine, container_id=1, name="b", kind="shell")
    c = await create_session(engine, container_id=1, name="c", kind="shell")
    sessions = await list_sessions(engine, container_id=1)
    assert [s.session_id for s in sessions] == [a.session_id, b.session_id, c.session_id]
    assert [s.position for s in sessions] == [1, 2, 3]


@pytest.mark.asyncio
async def test_patch_session_name_only(engine) -> None:
    from hub.services.named_sessions import create_session, patch_session

    a = await create_session(engine, container_id=1, name="orig", kind="shell")
    updated = await patch_session(engine, session_id=a.session_id, name="new")
    assert updated.name == "new"
    assert updated.position == a.position


@pytest.mark.asyncio
async def test_patch_session_position_move_up(engine) -> None:
    from hub.services.named_sessions import create_session, list_sessions, patch_session

    a = await create_session(engine, container_id=1, name="a", kind="shell")
    b = await create_session(engine, container_id=1, name="b", kind="shell")
    c = await create_session(engine, container_id=1, name="c", kind="shell")
    await patch_session(engine, session_id=c.session_id, position=1)
    sessions = await list_sessions(engine, container_id=1)
    assert [s.session_id for s in sessions] == [c.session_id, a.session_id, b.session_id]
    assert [s.position for s in sessions] == [1, 2, 3]


@pytest.mark.asyncio
async def test_patch_session_position_move_down(engine) -> None:
    from hub.services.named_sessions import create_session, list_sessions, patch_session

    a = await create_session(engine, container_id=1, name="a", kind="shell")
    b = await create_session(engine, container_id=1, name="b", kind="shell")
    c = await create_session(engine, container_id=1, name="c", kind="shell")
    await patch_session(engine, session_id=a.session_id, position=3)
    sessions = await list_sessions(engine, container_id=1)
    assert [s.session_id for s in sessions] == [b.session_id, c.session_id, a.session_id]


@pytest.mark.asyncio
async def test_patch_session_position_clamps_over_end(engine) -> None:
    from hub.services.named_sessions import create_session, list_sessions, patch_session

    a = await create_session(engine, container_id=1, name="a", kind="shell")
    b = await create_session(engine, container_id=1, name="b", kind="shell")
    await patch_session(engine, session_id=a.session_id, position=999)
    sessions = await list_sessions(engine, container_id=1)
    assert [s.session_id for s in sessions] == [b.session_id, a.session_id]
    assert sessions[-1].position == 2


@pytest.mark.asyncio
async def test_patch_session_name_and_position_atomic(engine) -> None:
    from hub.services.named_sessions import create_session, list_sessions, patch_session

    a = await create_session(engine, container_id=1, name="a", kind="shell")
    b = await create_session(engine, container_id=1, name="b", kind="shell")
    updated = await patch_session(
        engine,
        session_id=a.session_id,
        name="renamed",
        position=2,
    )
    assert updated.name == "renamed"
    assert updated.position == 2
    sessions = await list_sessions(engine, container_id=1)
    assert [s.session_id for s in sessions] == [b.session_id, a.session_id]


@pytest.mark.asyncio
async def test_patch_session_empty_raises(engine) -> None:
    from hub.services.named_sessions import create_session, patch_session

    a = await create_session(engine, container_id=1, name="a", kind="shell")
    with pytest.raises(ValueError):
        await patch_session(engine, session_id=a.session_id)


@pytest.mark.asyncio
async def test_patch_session_missing_raises_session_not_found(engine) -> None:
    from hub.services.named_sessions import SessionNotFound, patch_session

    with pytest.raises(SessionNotFound):
        await patch_session(engine, session_id="nope", name="x")


@pytest.mark.asyncio
async def test_delete_session_returns_container_id(engine) -> None:
    """M30 — delete returns the container_id of the removed row so
    routers can broadcast the post-delete list; returns None for a
    missing id."""
    from hub.services.named_sessions import create_session, delete_session

    session = await create_session(engine, container_id=1, name="gone", kind="shell")
    result = await delete_session(engine, session_id=session.session_id)
    assert result == 1

    missing = await delete_session(engine, session_id="nope")
    assert missing is None
