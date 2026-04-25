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
