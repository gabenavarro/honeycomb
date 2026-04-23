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
    """Insert a new session row and return the populated model.

    Position is assigned as ``max(position) + 1`` within the same
    container — sessions always slot in at the end.
    """
    session_id = uuid.uuid4().hex
    now = datetime.now().isoformat()
    async with engine.begin() as conn:
        next_pos = (
            await conn.execute(
                sa.text(
                    "SELECT COALESCE(MAX(position), 0) + 1 FROM sessions WHERE container_id = :cid"
                ),
                {"cid": container_id},
            )
        ).scalar_one()
        await conn.execute(
            sa.text(
                "INSERT INTO sessions "
                "(session_id, container_id, name, kind, position, "
                "created_at, updated_at) "
                "VALUES (:sid, :cid, :name, :kind, :pos, :now, :now)"
            ),
            {
                "sid": session_id,
                "cid": container_id,
                "name": name,
                "kind": kind,
                "pos": next_pos,
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
                        "ORDER BY position ASC, created_at ASC, session_id ASC"
                    ),
                    {"cid": container_id},
                )
            )
            .mappings()
            .all()
        )
    return [_row_to_model(r) for r in rows]


async def patch_session(
    engine: AsyncEngine,
    *,
    session_id: str,
    name: str | None = None,
    position: int | None = None,
) -> NamedSession:
    """Apply a partial update to a session row.

    Raises ``SessionNotFound`` when ``session_id`` doesn't exist.
    Raises ``ValueError`` when neither ``name`` nor ``position`` is
    provided (router translates to 422).

    When ``position`` is set, the service opens a transaction,
    removes the moved row from the current ordering, reinserts at
    the (clamped) requested index, and renumbers every row in the
    same container to positions 1..N.
    """
    if name is None and position is None:
        raise ValueError("patch requires at least one field")

    now = datetime.now().isoformat()
    async with engine.begin() as conn:
        current = (
            (
                await conn.execute(
                    sa.text("SELECT container_id, position FROM sessions WHERE session_id = :sid"),
                    {"sid": session_id},
                )
            )
            .mappings()
            .first()
        )
        if current is None:
            raise SessionNotFound(session_id)

        if position is not None:
            await _reorder_within_container(
                conn,
                container_id=current["container_id"],
                moved_session_id=session_id,
                new_position=position,
            )

        if name is not None:
            await conn.execute(
                sa.text(
                    "UPDATE sessions SET name = :name, updated_at = :now WHERE session_id = :sid"
                ),
                {"name": name, "now": now, "sid": session_id},
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


async def _reorder_within_container(
    conn,
    *,
    container_id: int,
    moved_session_id: str,
    new_position: int,
) -> None:
    """Move one session to ``new_position`` and renumber the rest
    atomically inside an open transaction.

    Positions are rewritten to contiguous 1..N after the move. The
    ``new_position`` is clamped to ``[1, len(ids)+1]``.
    """
    rows = (
        (
            await conn.execute(
                sa.text(
                    "SELECT session_id FROM sessions "
                    "WHERE container_id = :cid "
                    "ORDER BY position ASC, created_at ASC, session_id ASC"
                ),
                {"cid": container_id},
            )
        )
        .mappings()
        .all()
    )
    ids = [r["session_id"] for r in rows]
    if moved_session_id not in ids:
        raise SessionNotFound(moved_session_id)
    ids.remove(moved_session_id)
    target = max(1, min(new_position, len(ids) + 1))
    ids.insert(target - 1, moved_session_id)
    for new_pos, sid in enumerate(ids, start=1):
        await conn.execute(
            sa.text("UPDATE sessions SET position = :pos WHERE session_id = :sid"),
            {"pos": new_pos, "sid": sid},
        )


async def delete_session(
    engine: AsyncEngine,
    *,
    session_id: str,
) -> int | None:
    """Remove ``session_id`` if present. Idempotent — calling for a
    nonexistent id is a silent no-op (matches ``DELETE`` REST
    semantics).

    Returns the deleted row's ``container_id`` so callers can
    broadcast WS events after a successful delete; returns ``None``
    when the row didn't exist.
    """
    async with engine.begin() as conn:
        row = (
            await conn.execute(
                sa.text("SELECT container_id FROM sessions WHERE session_id = :sid"),
                {"sid": session_id},
            )
        ).first()
        if row is None:
            return None
        container_id = int(row[0])
        await conn.execute(
            sa.text("DELETE FROM sessions WHERE session_id = :sid"),
            {"sid": session_id},
        )
    return container_id
