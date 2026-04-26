"""Artifact service (M35) — CRUD over the artifacts table + read-time
synthesis of Edit artifacts from the existing diff_events table.

Architecture:
  - 7 types stored in `artifacts` table (plan/review/snippet/note/skill/subagent/spec)
  - 1 type synthesized from `diff_events` (edit) — read-only, immutable
  - list_artifacts UNIONs both sources, sorted by created_at DESC
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from hub.models.schemas import Artifact, ArtifactType, DiffEvent, WSFrame
from hub.routers.ws import ConnectionManager
from hub.services.diff_events import list_events as list_diff_events

logger = logging.getLogger(__name__)


def _row_to_artifact(row) -> Artifact:
    """Convert a DB row to an Artifact, parsing the JSON metadata column."""
    metadata: dict[str, Any] | None = None
    if row["metadata_json"]:
        try:
            metadata = json.loads(row["metadata_json"])
        except json.JSONDecodeError:
            logger.warning("Invalid JSON in artifact %s metadata_json", row["artifact_id"])
            metadata = None
    return Artifact(
        artifact_id=row["artifact_id"],
        container_id=row["container_id"],
        type=row["type"],
        title=row["title"],
        body=row["body"],
        body_format=row["body_format"],
        source_chat_id=row["source_chat_id"],
        source_message_id=row["source_message_id"],
        metadata_json=metadata,  # alias — sets the `metadata` field
        pinned=bool(row["pinned"]),
        archived=bool(row["archived"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def record_artifact(
    engine: AsyncEngine,
    *,
    container_id: int,
    type: ArtifactType,
    title: str,
    body: str,
    body_format: str = "markdown",
    source_chat_id: str | None = None,
    source_message_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> Artifact:
    """Insert a new artifact row and return the populated model."""
    artifact_id = uuid.uuid4().hex
    now = datetime.now().isoformat()
    metadata_json = json.dumps(metadata) if metadata is not None else None
    async with engine.begin() as conn:
        await conn.execute(
            sa.text(
                "INSERT INTO artifacts "
                "(artifact_id, container_id, type, title, body, body_format, "
                " source_chat_id, source_message_id, metadata_json, pinned, archived, "
                " created_at, updated_at) "
                "VALUES (:aid, :cid, :type, :title, :body, :body_format, "
                "        :scid, :smid, :meta, 0, 0, :ca, :ua)"
            ),
            {
                "aid": artifact_id,
                "cid": container_id,
                "type": type,
                "title": title,
                "body": body,
                "body_format": body_format,
                "scid": source_chat_id,
                "smid": source_message_id,
                "meta": metadata_json,
                "ca": now,
                "ua": now,
            },
        )
        row = (
            (
                await conn.execute(
                    sa.text("SELECT * FROM artifacts WHERE artifact_id = :aid"),
                    {"aid": artifact_id},
                )
            )
            .mappings()
            .one()
        )
    return _row_to_artifact(row)


def _synthesize_edit_from_diff_event(diff_event: DiffEvent) -> Artifact:
    """Translate a DiffEvent → Artifact (type=edit). Immutable; always
    pinned=False, archived=False."""
    return Artifact(
        artifact_id=f"edit-{diff_event.event_id}",
        container_id=diff_event.container_id,
        type="edit",
        title=f"{diff_event.tool}: {diff_event.path}",
        body=diff_event.diff,
        body_format="diff",
        source_chat_id=diff_event.claude_session_id,
        source_message_id=diff_event.tool_use_id,
        metadata_json={  # alias — sets the `metadata` field
            "paths": [diff_event.path],
            "lines_added": diff_event.added_lines,
            "lines_removed": diff_event.removed_lines,
            "tool": diff_event.tool,
            "size_bytes": diff_event.size_bytes,
        },
        pinned=False,
        archived=False,
        created_at=diff_event.created_at,
        updated_at=diff_event.created_at,
    )


async def list_artifacts(
    engine: AsyncEngine,
    *,
    container_id: int,
    types: Iterable[ArtifactType] | None = None,
    search: str | None = None,
    include_archived: bool = False,
    limit: int = 200,
) -> list[Artifact]:
    """List artifacts for a container with optional filters.

    Synthesizes Edit artifacts from diff_events at read time. The synthesis
    runs whenever the type filter is None or includes "edit".
    """
    types_set: set[str] | None = set(types) if types else None
    include_synth_edits = types_set is None or "edit" in types_set
    # Real query runs whenever (a) no type filter at all, or (b) the filter
    # contains at least one non-edit type.
    non_edit_types: list[str] = []
    if types_set is not None:
        non_edit_types = [t for t in types_set if t != "edit"]
    include_real = types_set is None or len(non_edit_types) > 0

    real_rows: list[Artifact] = []
    if include_real:
        clauses: list[str] = ["container_id = :cid"]
        params: dict[str, Any] = {"cid": container_id, "limit": limit}
        if not include_archived:
            clauses.append("archived = 0")
        if non_edit_types:
            placeholders = ", ".join(f":t{i}" for i in range(len(non_edit_types)))
            clauses.append(f"type IN ({placeholders})")
            for i, t in enumerate(non_edit_types):
                params[f"t{i}"] = t
        if search:
            clauses.append("(title LIKE :q OR body LIKE :q)")
            params["q"] = f"%{search}%"
        sql = (
            "SELECT * FROM artifacts "
            f"WHERE {' AND '.join(clauses)} "
            "ORDER BY created_at DESC "
            "LIMIT :limit"
        )
        async with engine.connect() as conn:
            rows = (await conn.execute(sa.text(sql), params)).mappings().all()
        real_rows = [_row_to_artifact(r) for r in rows]

    synth_edits: list[Artifact] = []
    if include_synth_edits:
        diff_rows = await list_diff_events(engine, container_id=container_id, limit=limit)
        for d in diff_rows:
            edit = _synthesize_edit_from_diff_event(d)
            # Apply the search filter to synthesized edits too
            if search:
                ql = search.lower()
                if ql not in edit.title.lower() and ql not in edit.body.lower():
                    continue
            synth_edits.append(edit)

    # Union + sort by created_at DESC, cap at limit
    combined = real_rows + synth_edits
    combined.sort(key=lambda a: a.created_at, reverse=True)
    return combined[:limit]


async def get_artifact(
    engine: AsyncEngine,
    *,
    artifact_id: str,
) -> Artifact | None:
    """Fetch one artifact by ID. Returns None if missing.

    Synthesized edit IDs (prefix `edit-`) are looked up against diff_events.
    """
    if artifact_id.startswith("edit-"):
        event_id = artifact_id.removeprefix("edit-")
        async with engine.connect() as conn:
            row = (
                (
                    await conn.execute(
                        sa.text("SELECT * FROM diff_events WHERE event_id = :eid"),
                        {"eid": event_id},
                    )
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        # Reuse the diff_events row_to_model + synthesize
        from hub.services.diff_events import _row_to_model as diff_row_to_model

        diff = diff_row_to_model(row)
        return _synthesize_edit_from_diff_event(diff)

    async with engine.connect() as conn:
        row = (
            (
                await conn.execute(
                    sa.text("SELECT * FROM artifacts WHERE artifact_id = :aid"),
                    {"aid": artifact_id},
                )
            )
            .mappings()
            .first()
        )
    return _row_to_artifact(row) if row is not None else None


async def _set_flag(engine: AsyncEngine, *, artifact_id: str, column: str, value: int) -> None:
    """Common helper for pin/unpin/archive."""
    if artifact_id.startswith("edit-"):
        # Synthesized edits are immutable — silently no-op.
        return
    async with engine.begin() as conn:
        await conn.execute(
            sa.text(
                f"UPDATE artifacts SET {column} = :v, updated_at = :ua WHERE artifact_id = :aid"
            ),
            {"v": value, "aid": artifact_id, "ua": datetime.now().isoformat()},
        )


async def pin_artifact(engine: AsyncEngine, *, artifact_id: str) -> None:
    await _set_flag(engine, artifact_id=artifact_id, column="pinned", value=1)


async def unpin_artifact(engine: AsyncEngine, *, artifact_id: str) -> None:
    await _set_flag(engine, artifact_id=artifact_id, column="pinned", value=0)


async def archive_artifact(engine: AsyncEngine, *, artifact_id: str) -> None:
    await _set_flag(engine, artifact_id=artifact_id, column="archived", value=1)


async def delete_artifact(engine: AsyncEngine, *, artifact_id: str) -> None:
    """Hard-delete an artifact. Idempotent. Synthesized edits silently no-op."""
    if artifact_id.startswith("edit-"):
        return
    async with engine.begin() as conn:
        await conn.execute(
            sa.text("DELETE FROM artifacts WHERE artifact_id = :aid"),
            {"aid": artifact_id},
        )


# ── Broadcast helpers (M35 T6) ────────────────────────────────────────


async def fetch_container_id_for_artifact(engine: AsyncEngine, artifact_id: str) -> int | None:
    """Return container_id for an artifact, or None if missing/synthesized."""
    if artifact_id.startswith("edit-"):
        return None  # edit artifacts can't be mutated
    async with engine.connect() as conn:
        row = (
            (
                await conn.execute(
                    sa.text("SELECT container_id FROM artifacts WHERE artifact_id = :aid"),
                    {"aid": artifact_id},
                )
            )
            .mappings()
            .first()
        )
    return row["container_id"] if row else None


async def broadcast_library_event(
    ws_manager: ConnectionManager,
    *,
    container_id: int,
    event: str,
    data: dict[str, Any],
) -> None:
    """Publish `event` on library:<container_id>. Best-effort."""
    frame = WSFrame(
        channel=f"library:{container_id}",
        event=event,
        data=data,
    )
    try:
        await ws_manager.broadcast(frame)
    except Exception as exc:
        logger.warning(
            "library broadcast failed (channel=%s, event=%s): %s",
            frame.channel,
            event,
            exc,
        )


# ── Spec auto-save helpers (M35) ──────────────────────────────────────

# Match the first markdown heading in the file
_HEADING_PATTERN = re.compile(r"^#\s+(.+)$", re.MULTILINE)


def _extract_headings(body: str) -> list[str]:
    """Pull all h1/h2 headings (for the spec metadata.headings list)."""
    return [
        m.group(0).lstrip("#").strip() for m in re.finditer(r"^#{1,2}\s+.+$", body, re.MULTILINE)
    ]


def _spec_title(body: str, fallback: str) -> str:
    """First # heading, or the fallback (filename stem) if absent."""
    m = _HEADING_PATTERN.search(body)
    return m.group(1).strip() if m is not None else fallback


async def rescan_spec_files(
    engine: AsyncEngine,
    *,
    container_id: int,
    specs_dir: Path,
) -> int:
    """Scan `specs_dir` for *.md files; record any not already in the
    artifacts table (lookup by metadata.file_path). Returns the count
    of new records.

    Idempotent: existing rows are skipped. Missing/empty directory is
    a silent no-op.
    """
    if not specs_dir.exists():
        return 0
    md_files = sorted(specs_dir.glob("*.md"))
    if not md_files:
        return 0

    async with engine.connect() as conn:
        rows = (
            (
                await conn.execute(
                    sa.text(
                        "SELECT artifact_id, metadata_json FROM artifacts "
                        "WHERE container_id = :cid AND type = 'spec'"
                    ),
                    {"cid": container_id},
                )
            )
            .mappings()
            .all()
        )
    existing_paths: set[str] = set()
    for r in rows:
        if r["metadata_json"]:
            try:
                meta = json.loads(r["metadata_json"])
                if "file_path" in meta:
                    existing_paths.add(meta["file_path"])
            except json.JSONDecodeError:
                logger.warning(
                    "spec_artifact_corrupt_metadata artifact_id=%s container_id=%s",
                    r["artifact_id"],
                    container_id,
                )
                continue

    new_count = 0
    for md_path in md_files:
        rel_path = str(md_path.relative_to(specs_dir.parent))
        if rel_path in existing_paths:
            continue
        body = md_path.read_text(encoding="utf-8", errors="replace")
        title = _spec_title(body, fallback=md_path.stem)
        await record_artifact(
            engine,
            container_id=container_id,
            type="spec",
            title=title,
            body=body,
            metadata={"file_path": rel_path, "headings": _extract_headings(body)},
        )
        new_count += 1
    return new_count
