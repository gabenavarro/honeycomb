"""Async SQLAlchemy-backed container registry (M7).

Schema + migrations moved out of this module: the table definition
lives in :mod:`hub.db.schema` and Alembic owns schema evolution via
:mod:`hub.db.migrations_runner`. Every query here is a SQLAlchemy Core
statement built from the ``containers`` table reference, so column
names are checked by the type system and any hand-written SQL string
stays out of the hot path.

Two properties preserved from the pre-M7 registry:

* Public API (``open``, ``get``, ``add``, ``update``, ``delete``,
  ``list_all``, ``get_by_workspace``, ``get_by_container_id``,
  ``update_by_container_id``, ``get_gpu_owner``) and the Pydantic
  :class:`ContainerRecord` shape stay identical.
* ``update()`` still enforces the container-state machine
  (:data:`ALLOWED_CONTAINER_TRANSITIONS`) and silently drops same-state
  transitions so a flaky heartbeat doesn't spam the WebSocket bus.

One property tightened:

* ``update()`` now rejects any column name outside
  :data:`ALLOWED_UPDATE_FIELDS`. Pre-M7 the column list came from
  ``**fields`` — safe because every caller already went through
  Pydantic validation, but a defence-in-depth belt-and-suspenders that
  caught at least one typo during the M7 refactor. A missing column
  now raises :class:`ValueError` instead of falling through to an
  ``UPDATE`` that writes to nothing.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from hub.db.migrations_runner import run_migrations
from hub.db.schema import containers
from hub.models.schemas import AgentStatus, ContainerRecord, ContainerStatus, ProjectType

logger = logging.getLogger("hub.registry")

DEFAULT_DB_PATH = Path.home() / ".claude-hive" / "registry.db"


class InvalidStateTransition(ValueError):
    """Raised when a caller attempts a container_status transition that is
    not allowed by the state machine. See ALLOWED_CONTAINER_TRANSITIONS."""


# Liberal state machine: most transitions are allowed because containers can
# crash, be discovered mid-state, or be manually rebuilt. The rules below
# forbid:
#   - same-state transitions (redundant writes mask bugs)
#   - ERROR → RUNNING without going through STARTING (containers must be
#     explicitly (re)started after a failure, not marked healthy in place)
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


# Columns a caller may pass to ``Registry.update()``. Any key outside
# this set raises :class:`ValueError`. ``id``, ``workspace_folder``,
# ``created_at`` are intentionally omitted — they're immutable post-
# creation. ``updated_at`` is managed by :meth:`Registry.update`.
ALLOWED_UPDATE_FIELDS: frozenset[str] = frozenset(
    {
        "project_type",
        "project_name",
        "project_description",
        "git_repo_url",
        "container_id",
        "container_status",
        "agent_status",
        "agent_expected",
        "agent_port",
        "has_gpu",
        "has_claude_cli",
        "claude_cli_checked_at",
    }
)


def _coerce_status(value: Any) -> ContainerStatus | None:
    if value is None:
        return None
    if isinstance(value, ContainerStatus):
        return value
    try:
        return ContainerStatus(value)
    except (ValueError, TypeError):
        return None


def _to_db_value(key: str, value: Any) -> Any:
    """Normalise a Python value into the representation the DB column uses.

    Enums flatten to their string value; datetimes to ISO-8601 text;
    booleans to 0/1 (SQLAlchemy does this for us, but being explicit
    keeps round-trips stable on the ``.value`` read paths). Unknown
    keys fall through unchanged — the allowlist check runs earlier.
    """
    if isinstance(value, ContainerStatus | AgentStatus | ProjectType):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _row_to_record(row: sa.Row) -> ContainerRecord:
    mapping = row._mapping
    return ContainerRecord(
        id=mapping["id"],
        workspace_folder=mapping["workspace_folder"],
        project_type=ProjectType(mapping["project_type"]),
        project_name=mapping["project_name"],
        project_description=mapping["project_description"],
        git_repo_url=mapping["git_repo_url"],
        container_id=mapping["container_id"],
        container_status=ContainerStatus(mapping["container_status"]),
        agent_status=AgentStatus(mapping["agent_status"]),
        agent_expected=bool(mapping["agent_expected"]),
        agent_port=mapping["agent_port"],
        has_gpu=bool(mapping["has_gpu"]),
        has_claude_cli=bool(mapping["has_claude_cli"]),
        claude_cli_checked_at=(
            datetime.fromisoformat(mapping["claude_cli_checked_at"])
            if mapping["claude_cli_checked_at"]
            else None
        ),
        created_at=datetime.fromisoformat(mapping["created_at"]),
        updated_at=datetime.fromisoformat(mapping["updated_at"]),
    )


class Registry:
    """Async registry backed by SQLAlchemy + aiosqlite."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = Path(db_path) if db_path else DEFAULT_DB_PATH
        self._engine: AsyncEngine | None = None

    async def open(self) -> None:
        """Run migrations to head, then open an async engine.

        Migrations run synchronously on the calling thread because
        Alembic's Python-side machinery isn't async-friendly. For a
        local SQLite file the DDL finishes in milliseconds; offloading
        to a thread would buy nothing.
        """
        run_migrations(self.db_path)
        # ``check_same_thread=False`` matches aiosqlite's default — the
        # engine pools connections internally and we never share raw
        # connections across asyncio tasks.
        self._engine = create_async_engine(
            f"sqlite+aiosqlite:///{self.db_path}",
            connect_args={"check_same_thread": False},
            future=True,
        )
        logger.info("Registry opened at %s", self.db_path)

    async def close(self) -> None:
        if self._engine is not None:
            await self._engine.dispose()
            self._engine = None

    @property
    def engine(self) -> AsyncEngine:
        if self._engine is None:
            raise RuntimeError("Registry not opened. Call await registry.open() first.")
        return self._engine

    async def add(
        self,
        workspace_folder: str,
        project_type: str,
        project_name: str,
        project_description: str = "",
        git_repo_url: str | None = None,
        has_gpu: bool = False,
        agent_expected: bool = True,
    ) -> ContainerRecord:
        now = datetime.now().isoformat()
        stmt = (
            sa.insert(containers)
            .values(
                workspace_folder=workspace_folder,
                project_type=project_type,
                project_name=project_name,
                project_description=project_description,
                git_repo_url=git_repo_url,
                has_gpu=has_gpu,
                agent_expected=agent_expected,
                created_at=now,
                updated_at=now,
            )
            .returning(containers.c.id)
        )
        async with self.engine.begin() as conn:
            result = await conn.execute(stmt)
            record_id = result.scalar_one()
        return await self.get(record_id)

    async def get(self, record_id: int) -> ContainerRecord:
        stmt = sa.select(containers).where(containers.c.id == record_id)
        async with self.engine.connect() as conn:
            row = (await conn.execute(stmt)).fetchone()
        if row is None:
            raise KeyError(f"Container record {record_id} not found")
        return _row_to_record(row)

    async def get_by_workspace(self, workspace_folder: str) -> ContainerRecord | None:
        stmt = sa.select(containers).where(containers.c.workspace_folder == workspace_folder)
        async with self.engine.connect() as conn:
            row = (await conn.execute(stmt)).fetchone()
        return _row_to_record(row) if row is not None else None

    async def get_by_container_id(self, container_id: str) -> ContainerRecord | None:
        stmt = sa.select(containers).where(containers.c.container_id == container_id)
        async with self.engine.connect() as conn:
            row = (await conn.execute(stmt)).fetchone()
        return _row_to_record(row) if row is not None else None

    async def list_all(self) -> list[ContainerRecord]:
        stmt = sa.select(containers).order_by(containers.c.updated_at.desc())
        async with self.engine.connect() as conn:
            rows = (await conn.execute(stmt)).fetchall()
        return [_row_to_record(row) for row in rows]

    async def update(self, record_id: int, **fields: Any) -> ContainerRecord:
        if not fields:
            return await self.get(record_id)

        # Defence-in-depth: refuse unknown columns. Every caller today
        # goes through Pydantic, but this catches typos in new code
        # paths before they silently land an empty UPDATE.
        unknown = set(fields) - ALLOWED_UPDATE_FIELDS
        if unknown:
            raise ValueError(
                "Unknown update fields: "
                f"{sorted(unknown)}. Allowed: {sorted(ALLOWED_UPDATE_FIELDS)}"
            )

        # State machine: validate container_status transitions before writing.
        new_status = _coerce_status(fields.get("container_status"))
        if new_status is not None:
            current = await self.get(record_id)
            allowed = ALLOWED_CONTAINER_TRANSITIONS.get(current.container_status, set())
            if new_status == current.container_status:
                fields.pop("container_status")
                if not fields:
                    return current
            elif new_status not in allowed:
                raise InvalidStateTransition(
                    f"Container {record_id}: cannot transition "
                    f"{current.container_status.value} -> {new_status.value}. "
                    f"Allowed from {current.container_status.value}: "
                    f"{sorted(s.value for s in allowed)}"
                )

        if not fields:
            return await self.get(record_id)

        values = {k: _to_db_value(k, v) for k, v in fields.items()}
        values["updated_at"] = datetime.now().isoformat()
        stmt = sa.update(containers).where(containers.c.id == record_id).values(**values)
        async with self.engine.begin() as conn:
            await conn.execute(stmt)
        return await self.get(record_id)

    async def update_by_container_id(
        self, container_id: str, **fields: Any
    ) -> ContainerRecord | None:
        record = await self.get_by_container_id(container_id)
        if record is None:
            return None
        return await self.update(record.id, **fields)

    async def delete(self, record_id: int) -> bool:
        stmt = sa.delete(containers).where(containers.c.id == record_id)
        async with self.engine.begin() as conn:
            result = await conn.execute(stmt)
        return (result.rowcount or 0) > 0

    async def get_gpu_owner(self) -> ContainerRecord | None:
        """Return the container currently holding the (single) GPU, if any."""
        stmt = sa.select(containers).where(
            containers.c.has_gpu == sa.true(),
            containers.c.container_status == ContainerStatus.RUNNING.value,
        )
        async with self.engine.connect() as conn:
            row = (await conn.execute(stmt)).fetchone()
        return _row_to_record(row) if row is not None else None
