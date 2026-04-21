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
    """Raised when rename targets a nonexistent session_id.

    The router maps this to HTTP 404 via exception handlers. delete
    callers don't raise — delete is idempotent by design.
    """


def _row_to_model(row) -> NamedSession:
    return NamedSession(
        session_id=row["session_id"],
        container_id=row["container_id"],
        name=row["name"],
        kind=row["kind"],
        position=row["position"],
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
    now = datetime.now().isoformat()
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
            (
                await conn.execute(
                    sa.text(
                        "SELECT session_id, container_id, name, kind, position, "
                        "created_at, updated_at FROM sessions "
                        "WHERE session_id = :sid"
                    ),
                    {"sid": session_id},
                )
            )
            .mappings()
            .one()
        )
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
            (
                await conn.execute(
                    sa.text(
                        "SELECT session_id, container_id, name, kind, position, "
                        "created_at, updated_at FROM sessions "
                        "WHERE container_id = :cid "
                        "ORDER BY created_at ASC, session_id ASC"
                    ),
                    {"cid": container_id},
                )
            )
            .mappings()
            .all()
        )
    return [_row_to_model(r) for r in rows]


async def rename_session(
    engine: AsyncEngine,
    *,
    session_id: str,
    name: str,
) -> NamedSession:
    """Update the name + bump ``updated_at``. Raises
    ``SessionNotFound`` when ``session_id`` doesn't exist."""
    now = datetime.now().isoformat()
    async with engine.begin() as conn:
        result = await conn.execute(
            sa.text("UPDATE sessions SET name = :name, updated_at = :now WHERE session_id = :sid"),
            {"name": name, "now": now, "sid": session_id},
        )
        if result.rowcount == 0:
            raise SessionNotFound(session_id)
        row = (
            (
                await conn.execute(
                    sa.text(
                        "SELECT session_id, container_id, name, kind, position, "
                        "created_at, updated_at FROM sessions "
                        "WHERE session_id = :sid"
                    ),
                    {"sid": session_id},
                )
            )
            .mappings()
            .one()
        )
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
