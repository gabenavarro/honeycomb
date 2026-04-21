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
async def list_named_sessions(record_id: int, request: Request) -> list[NamedSession]:
    """List all persistent sessions for a container, oldest first."""
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
async def delete_named_session_endpoint(session_id: str, request: Request) -> None:
    """Delete a session. Idempotent — 204 even when the row didn't exist."""
    registry = request.app.state.registry
    await delete_session(registry.engine, session_id=session_id)
