"""Database layer for the Claude Hive hub.

Since M7 the hub uses SQLAlchemy Core (not the ORM) with an async
aiosqlite driver for all persistent storage. Schema evolution is
managed by Alembic; migrations live in ``hub/db/migrations/`` and are
applied automatically on lifespan start-up.

The public surface is still :class:`hub.services.registry.Registry`
— everything in this package is implementation detail.
"""
