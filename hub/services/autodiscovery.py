"""Startup auto-discovery — historical shim that no longer does anything.

Pre-M4 this module scanned running Docker containers for a hive-agent
HTTP listener on port 9100 and auto-registered those. Since M4 the
agent initiates the connection instead, so there is nothing to discover
at startup — containers register themselves the moment their agent
completes its first handshake against ``/api/agent/connect``. See
:func:`hub.routers.agent.agent_connect` for the auto-register code
path.

The function is kept as a no-op so the hub's lifespan start-up code
continues to import it cleanly during migration; callers get 0 back and
can remove the invocation whenever convenient.
"""

from __future__ import annotations

import logging

from hub.services.registry import Registry

logger = logging.getLogger("hub.autodiscovery")


async def discover_containers(_registry: Registry) -> int:
    """No-op since M4. Always returns 0."""
    logger.debug("startup_autodiscovery_skipped", extra={"reason": "moved to agent-connect"})
    return 0
