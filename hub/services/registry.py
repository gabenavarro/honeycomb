"""SQLite container registry — persistent store for all tracked devcontainers."""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any

import aiosqlite

from hub.models.schemas import AgentStatus, ContainerRecord, ContainerStatus, ProjectType

logger = logging.getLogger("hub.registry")

DEFAULT_DB_PATH = Path.home() / ".claude-hive" / "registry.db"


class InvalidStateTransition(ValueError):
    """Raised when a caller attempts a container_status transition that is
    not allowed by the state machine. See ALLOWED_CONTAINER_TRANSITIONS."""


# Liberal state machine: we allow most transitions because containers can
# crash, be discovered mid-state, or be manually rebuilt. The rules below
# forbid:
#  - same-state transitions (redundant writes mask bugs)
#  - ERROR → RUNNING without going through STARTING (containers must be
#    explicitly (re)started after a failure, not marked healthy in place)
ALLOWED_CONTAINER_TRANSITIONS: dict[ContainerStatus, set[ContainerStatus]] = {
    ContainerStatus.UNKNOWN: {
        ContainerStatus.STARTING,
        ContainerStatus.RUNNING,
        ContainerStatus.STOPPED,
        ContainerStatus.ERROR,
    },
    ContainerStatus.STARTING: {
        ContainerStatus.RUNNING,
        ContainerStatus.ERROR,
        ContainerStatus.STOPPED,
        ContainerStatus.UNKNOWN,
    },
    ContainerStatus.RUNNING: {
        ContainerStatus.STOPPED,
        ContainerStatus.STARTING,
        ContainerStatus.ERROR,
        ContainerStatus.UNKNOWN,
    },
    ContainerStatus.STOPPED: {
        ContainerStatus.STARTING,
        ContainerStatus.RUNNING,
        ContainerStatus.ERROR,
        ContainerStatus.UNKNOWN,
    },
    ContainerStatus.ERROR: {
        ContainerStatus.STARTING,
        ContainerStatus.STOPPED,
        ContainerStatus.UNKNOWN,
    },
}


def _coerce_status(value: Any) -> ContainerStatus | None:
    if value is None:
        return None
    if isinstance(value, ContainerStatus):
        return value
    try:
        return ContainerStatus(value)
    except (ValueError, TypeError):
        return None


CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS containers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_folder TEXT UNIQUE NOT NULL,
    project_type TEXT NOT NULL DEFAULT 'base',
    project_name TEXT NOT NULL,
    project_description TEXT NOT NULL DEFAULT '',
    git_repo_url TEXT,
    container_id TEXT,
    container_status TEXT NOT NULL DEFAULT 'unknown',
    agent_status TEXT NOT NULL DEFAULT 'unreachable',
    agent_port INTEGER NOT NULL DEFAULT 9100,
    has_gpu INTEGER NOT NULL DEFAULT 0,
    has_claude_cli INTEGER NOT NULL DEFAULT 0,
    claude_cli_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""

# Idempotent additions for registries created before these columns
# existed. Each ALTER is wrapped so a pre-existing column doesn't error.
_MIGRATIONS: list[str] = [
    "ALTER TABLE containers ADD COLUMN has_claude_cli INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE containers ADD COLUMN claude_cli_checked_at TEXT",
]


def _row_to_record(row: aiosqlite.Row) -> ContainerRecord:
    keys = row.keys()
    claude_checked_raw = row["claude_cli_checked_at"] if "claude_cli_checked_at" in keys else None
    return ContainerRecord(
        id=row["id"],
        workspace_folder=row["workspace_folder"],
        project_type=ProjectType(row["project_type"]),
        project_name=row["project_name"],
        project_description=row["project_description"],
        git_repo_url=row["git_repo_url"],
        container_id=row["container_id"],
        container_status=ContainerStatus(row["container_status"]),
        agent_status=AgentStatus(row["agent_status"]),
        agent_port=row["agent_port"],
        has_gpu=bool(row["has_gpu"]),
        has_claude_cli=bool(row["has_claude_cli"]) if "has_claude_cli" in keys else False,
        claude_cli_checked_at=(
            datetime.fromisoformat(claude_checked_raw) if claude_checked_raw else None
        ),
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


class Registry:
    """Async SQLite registry for container records."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = Path(db_path) if db_path else DEFAULT_DB_PATH
        self._db: aiosqlite.Connection | None = None

    async def open(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(str(self.db_path))
        self._db.row_factory = aiosqlite.Row
        await self._db.execute(CREATE_TABLE)
        # Apply idempotent ALTERs for pre-existing DBs. SQLite errors on
        # duplicate column — swallow that specific case.
        for migration in _MIGRATIONS:
            try:
                await self._db.execute(migration)
            except aiosqlite.OperationalError as exc:
                msg = str(exc).lower()
                if "duplicate column" in msg:
                    continue
                raise
        await self._db.commit()
        logger.info("Registry opened at %s", self.db_path)

    async def close(self) -> None:
        if self._db:
            await self._db.close()
            self._db = None

    @property
    def db(self) -> aiosqlite.Connection:
        if self._db is None:
            raise RuntimeError("Registry not opened. Call await registry.open() first.")
        return self._db

    async def add(
        self,
        workspace_folder: str,
        project_type: str,
        project_name: str,
        project_description: str = "",
        git_repo_url: str | None = None,
        has_gpu: bool = False,
    ) -> ContainerRecord:
        now = datetime.now().isoformat()
        cursor = await self.db.execute(
            """INSERT INTO containers
               (workspace_folder, project_type, project_name, project_description,
                git_repo_url, has_gpu, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                workspace_folder,
                project_type,
                project_name,
                project_description,
                git_repo_url,
                int(has_gpu),
                now,
                now,
            ),
        )
        await self.db.commit()
        return await self.get(cursor.lastrowid)  # type: ignore[arg-type]

    async def get(self, record_id: int) -> ContainerRecord:
        cursor = await self.db.execute("SELECT * FROM containers WHERE id = ?", (record_id,))
        row = await cursor.fetchone()
        if row is None:
            raise KeyError(f"Container record {record_id} not found")
        return _row_to_record(row)

    async def get_by_workspace(self, workspace_folder: str) -> ContainerRecord | None:
        cursor = await self.db.execute(
            "SELECT * FROM containers WHERE workspace_folder = ?", (workspace_folder,)
        )
        row = await cursor.fetchone()
        return _row_to_record(row) if row else None

    async def get_by_container_id(self, container_id: str) -> ContainerRecord | None:
        cursor = await self.db.execute(
            "SELECT * FROM containers WHERE container_id = ?", (container_id,)
        )
        row = await cursor.fetchone()
        return _row_to_record(row) if row else None

    async def list_all(self) -> list[ContainerRecord]:
        cursor = await self.db.execute("SELECT * FROM containers ORDER BY updated_at DESC")
        rows = await cursor.fetchall()
        return [_row_to_record(row) for row in rows]

    async def update(self, record_id: int, **fields: Any) -> ContainerRecord:
        if not fields:
            return await self.get(record_id)

        # State machine: validate container_status transitions before writing.
        new_status = _coerce_status(fields.get("container_status"))
        if new_status is not None:
            current = await self.get(record_id)
            allowed = ALLOWED_CONTAINER_TRANSITIONS.get(current.container_status, set())
            if new_status == current.container_status:
                # Silently drop no-op transitions — these hide bugs and spam
                # WebSocket subscribers.
                fields.pop("container_status")
                if not {k for k in fields if k != "updated_at"}:
                    return current
            elif new_status not in allowed:
                raise InvalidStateTransition(
                    f"Container {record_id}: cannot transition "
                    f"{current.container_status.value} -> {new_status.value}. "
                    f"Allowed from {current.container_status.value}: "
                    f"{sorted(s.value for s in allowed)}"
                )

        fields["updated_at"] = datetime.now().isoformat()
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        values = [*list(fields.values()), record_id]
        await self.db.execute(f"UPDATE containers SET {set_clause} WHERE id = ?", values)
        await self.db.commit()
        return await self.get(record_id)

    async def update_by_container_id(
        self, container_id: str, **fields: Any
    ) -> ContainerRecord | None:
        record = await self.get_by_container_id(container_id)
        if record is None:
            return None
        return await self.update(record.id, **fields)

    async def delete(self, record_id: int) -> bool:
        cursor = await self.db.execute("DELETE FROM containers WHERE id = ?", (record_id,))
        await self.db.commit()
        return cursor.rowcount > 0

    async def get_gpu_owner(self) -> ContainerRecord | None:
        """Get the container that currently owns the GPU."""
        cursor = await self.db.execute(
            "SELECT * FROM containers WHERE has_gpu = 1 AND container_status = 'running'"
        )
        row = await cursor.fetchone()
        return _row_to_record(row) if row else None
