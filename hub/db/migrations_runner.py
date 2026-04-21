"""Apply Alembic migrations on lifespan start-up (M7).

The hub is single-user local, so we run migrations automatically
instead of asking the operator to invoke ``alembic upgrade head`` by
hand. The registry file lives at ``HiveSettings.db_path`` by default
(``~/.claude-hive/registry.db``); if that file is present but the
schema is incompatible with the current code, we back it up with a
timestamp suffix and continue with a fresh file rather than crashing
the whole hub.

Why "back up and continue" instead of failing hard?
---------------------------------------------------
A fresh-local checkout should Just Work. The registry holds
workspace→container bindings — recoverable from running Docker
containers (auto-discovery re-registers them) — not irreplaceable
state. An operator staring at a crashed hub has a worse UX than one
who gets a warning log telling them exactly which file we moved
aside and how to roll back.
"""

from __future__ import annotations

import logging
import shutil
from datetime import UTC, datetime
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect
from sqlalchemy.exc import OperationalError

logger = logging.getLogger("hub.db.migrations")

ALEMBIC_INI = Path(__file__).parent / "alembic.ini"


def _alembic_config(db_path: Path) -> Config:
    """Build an in-memory Alembic config wired at the given SQLite file."""
    cfg = Config(str(ALEMBIC_INI))
    # Override sqlalchemy.url at runtime so tests and the live hub
    # both point Alembic at the right file without touching the .ini.
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    # Also override the script_location so tests running from a temp
    # CWD still find the migrations tree.
    cfg.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
    return cfg


def _backup_incompatible_db(db_path: Path, reason: str) -> Path:
    """Rename ``db_path`` to ``…registry.db.bak-YYYYmmddHHMMSS``.

    Returns the backup path. The caller should log it so the operator
    can roll back if desired.
    """
    stamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    backup = db_path.with_name(f"{db_path.name}.bak-{stamp}")
    shutil.move(str(db_path), str(backup))
    logger.warning(
        "registry_backup_created",
        extra={
            "reason": reason,
            "backup_path": str(backup),
            "original_path": str(db_path),
        },
    )
    return backup


def _legacy_schema_needs_reset(db_path: Path) -> str | None:
    """Detect pre-Alembic registries. Returns a reason string when a
    reset is warranted, or None when the DB is either empty or already
    under Alembic management.

    A "legacy" registry is one that has a ``containers`` table but no
    ``alembic_version`` table — i.e. it was created by the hand-rolled
    ``CREATE TABLE IF NOT EXISTS`` + ad-hoc ``ALTER`` path used pre-M7.
    """
    if not db_path.exists():
        return None
    try:
        engine = create_engine(f"sqlite:///{db_path}")
        insp = inspect(engine)
        tables = set(insp.get_table_names())
    except OperationalError as exc:
        return f"database_open_failed: {exc}"

    if not tables:
        return None  # empty DB — Alembic will create fresh
    if "alembic_version" in tables:
        return None  # already managed
    if "containers" in tables:
        return "legacy_registry_without_alembic_version"
    return None


def apply_migrations_sync(db_path: Path) -> None:
    """Alias for :func:`run_migrations` — used by tests that prefer the
    more explicit name."""
    run_migrations(db_path)


def run_migrations(db_path: Path) -> None:
    """Ensure the DB file exists and is at the latest Alembic revision.

    Behaviour:

    * Empty or missing DB → Alembic creates the schema from scratch.
    * DB with ``alembic_version`` → upgrade to head (no-op if current).
    * Legacy DB (pre-M7 format) → back up with a timestamp suffix,
      then create a fresh DB at the original path.
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)

    reset_reason = _legacy_schema_needs_reset(db_path)
    if reset_reason is not None:
        _backup_incompatible_db(db_path, reset_reason)

    cfg = _alembic_config(db_path)
    logger.info(
        "registry_migrations_begin",
        extra={"db_path": str(db_path)},
    )
    command.upgrade(cfg, "head")
    logger.info("registry_migrations_complete", extra={"db_path": str(db_path)})
