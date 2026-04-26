"""Endpoint tests for the chat-stream router (M33)."""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine

from hub.config import HiveSettings
from hub.db.migrations_runner import apply_migrations_sync
from hub.models.schemas import AgentStatus, ContainerRecord, ContainerStatus, ProjectType
from hub.services.named_sessions import create_session, get_session

AUTH = {"Authorization": "Bearer test-token"}


@pytest_asyncio.fixture
async def registry_engine(tmp_path: Path):
    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
    # Seed a container row so sessions can FK to it.
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
    eng = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    yield eng
    await eng.dispose()


@pytest.fixture
def registered_container() -> ContainerRecord:
    """Minimal ContainerRecord mirroring the seeded row in registry_engine."""
    from datetime import datetime

    ts = datetime.fromisoformat("2026-04-20T00:00:00")
    return ContainerRecord(
        id=1,
        workspace_folder="/w",
        project_type=ProjectType.BASE,
        project_name="demo",
        project_description="",
        container_status=ContainerStatus.RUNNING,
        agent_status=AgentStatus.IDLE,
        created_at=ts,
        updated_at=ts,
    )


@pytest_asyncio.fixture
async def client(registry_engine, registered_container, tmp_path: Path):
    from hub.main import app
    from hub.services.registry import Registry

    # Retrieve the DB path from the engine URL
    db_url = str(registry_engine.url)
    db_path = Path(db_url.replace("sqlite+aiosqlite:///", ""))

    reg = Registry(db_path=db_path)
    await reg.open()

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.registry = reg

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c

    await reg.close()


@pytest.mark.asyncio
async def test_post_turn_404_unknown_session(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/named-sessions/does-not-exist/turns",
        json={"text": "hi"},
        headers=AUTH,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_post_turn_422_empty_text(
    client: AsyncClient, registered_container: ContainerRecord, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="t", kind="claude"
    )
    resp = await client.post(
        f"/api/named-sessions/{sess.session_id}/turns",
        json={"text": ""},
        headers=AUTH,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_post_turn_409_only_for_claude_kind(
    client: AsyncClient, registered_container: ContainerRecord, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="shell", kind="shell"
    )
    resp = await client.post(
        f"/api/named-sessions/{sess.session_id}/turns",
        json={"text": "hi"},
        headers=AUTH,
    )
    assert resp.status_code == 409  # not a claude session


@pytest.mark.asyncio
async def test_post_turn_spawns_and_returns_202(
    client: AsyncClient, registered_container: ContainerRecord, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R",
        (),
        {
            "exit_code": 0,
            "captured_claude_session_id": "claude-sess-xyz",
            "forwarded_count": 5,
        },
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "hello"},
            headers=AUTH,
        )
    assert resp.status_code == 202

    # The background _drive task may not have completed yet — give it a beat.
    await asyncio.sleep(0.05)

    # ClaudeTurnSession.run was awaited with the user text
    fake_session.run.assert_awaited_once()
    call_kwargs = fake_session.run.await_args.kwargs
    assert call_kwargs["user_text"] == "hello"
    assert call_kwargs["claude_session_id"] is None  # first turn

    # Captured session ID was persisted
    refreshed = await get_session(registry_engine, session_id=sess.session_id)
    assert refreshed is not None
    assert refreshed.claude_session_id == "claude-sess-xyz"


@pytest.mark.asyncio
async def test_post_turn_passes_resume_on_subsequent_turns(
    client: AsyncClient, registered_container: ContainerRecord, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )
    # Pre-populate the captured Claude session id
    from hub.services.named_sessions import set_claude_session_id

    await set_claude_session_id(
        registry_engine, session_id=sess.session_id, claude_session_id="prev-claude-id"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R",
        (),
        {
            "exit_code": 0,
            "captured_claude_session_id": "prev-claude-id",
            "forwarded_count": 1,
        },
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "follow-up"},
            headers=AUTH,
        )
    assert resp.status_code == 202
    await asyncio.sleep(0.05)
    call_kwargs = fake_session.run.await_args.kwargs
    assert call_kwargs["claude_session_id"] == "prev-claude-id"


@pytest.mark.asyncio
async def test_delete_active_turn_cancels(
    client: AsyncClient, registered_container: ContainerRecord, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )
    fake_session = AsyncMock()

    started = asyncio.Event()
    finished = asyncio.Event()

    async def slow_run(**_):
        started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            finished.set()
            raise
        return type(
            "R",
            (),
            {"exit_code": 0, "captured_claude_session_id": None, "forwarded_count": 0},
        )()

    fake_session.run = slow_run

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        # POST /turns kicks off the background task
        post_task = asyncio.create_task(
            client.post(
                f"/api/named-sessions/{sess.session_id}/turns",
                json={"text": "hi"},
                headers=AUTH,
            )
        )
        await started.wait()
        # Now cancel
        cancel_resp = await client.delete(
            f"/api/named-sessions/{sess.session_id}/turns/active",
            headers=AUTH,
        )
    assert cancel_resp.status_code == 204
    # Cleanup
    fake_session.cancel.assert_awaited()
    post_task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await post_task


@pytest.mark.asyncio
async def test_post_turn_accepts_effort_field(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": "claude-x", "forwarded_count": 1}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "hi", "effort": "max"},
            headers=AUTH,
        )
    assert resp.status_code == 202
    await asyncio.sleep(0.05)

    fake_session.run.assert_awaited_once()
    kwargs = fake_session.run.await_args.kwargs
    assert kwargs["effort"] == "max"


@pytest.mark.asyncio
async def test_post_turn_accepts_model_field(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": None, "forwarded_count": 0}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "hi", "model": "claude-opus-4-7[1m]"},
            headers=AUTH,
        )
    assert resp.status_code == 202
    await asyncio.sleep(0.05)
    assert fake_session.run.await_args.kwargs["model"] == "claude-opus-4-7[1m]"


@pytest.mark.asyncio
async def test_post_turn_accepts_mode_field(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": None, "forwarded_count": 0}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "hi", "mode": "plan"},
            headers=AUTH,
        )
    assert resp.status_code == 202
    await asyncio.sleep(0.05)
    assert fake_session.run.await_args.kwargs["mode"] == "plan"


@pytest.mark.asyncio
async def test_post_turn_accepts_edit_auto_field(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": None, "forwarded_count": 0}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "hi", "edit_auto": True},
            headers=AUTH,
        )
    assert resp.status_code == 202
    await asyncio.sleep(0.05)
    assert fake_session.run.await_args.kwargs["edit_auto"] is True


@pytest.mark.asyncio
async def test_post_turn_rejects_invalid_effort(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )
    resp = await client.post(
        f"/api/named-sessions/{sess.session_id}/turns",
        json={"text": "hi", "effort": "bogus"},
        headers=AUTH,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_post_turn_rejects_invalid_mode(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )
    resp = await client.post(
        f"/api/named-sessions/{sess.session_id}/turns",
        json={"text": "hi", "mode": "destruct"},
        headers=AUTH,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_post_turn_defaults_when_fields_omitted(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    """Backwards-compat: M33-style payload without the new fields still works."""
    sess = await create_session(
        registry_engine, container_id=registered_container.id, name="c", kind="claude"
    )

    fake_session = AsyncMock()
    fake_session.run.return_value = type(
        "R", (), {"exit_code": 0, "captured_claude_session_id": None, "forwarded_count": 0}
    )()

    with patch("hub.routers.chat_stream.ClaudeTurnSession", return_value=fake_session):
        resp = await client.post(
            f"/api/named-sessions/{sess.session_id}/turns",
            json={"text": "hi"},
            headers=AUTH,
        )
    assert resp.status_code == 202
    await asyncio.sleep(0.05)
    kwargs = fake_session.run.await_args.kwargs
    assert kwargs["effort"] == "standard"
    assert kwargs["model"] is None
    assert kwargs["mode"] == "code"
    assert kwargs["edit_auto"] is False
