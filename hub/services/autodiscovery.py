"""Auto-discovery — scan running Docker containers for hive-agent on hub startup.

Thin wrapper over hub.services.discovery that auto-registers any running
container already speaking to the hive-agent. Containers *without* the
agent are surfaced through /api/discover/containers so the user can
register them manually (we don't auto-register those — they'd likely be
unrelated Docker workloads).
"""

from __future__ import annotations

import logging

from hub.services.discovery import (
    registered_filter_sets,
    scan_container_candidates,
)
from hub.services.registry import Registry

logger = logging.getLogger("hub.autodiscovery")


async def discover_containers(registry: Registry) -> int:
    """Auto-register running containers that already have hive-agent.

    Returns the number of newly registered containers.
    """
    _workspaces, container_ids = await registered_filter_sets(registry)
    candidates = await scan_container_candidates(container_ids)

    registered = 0
    for cand in candidates:
        if not cand.has_hive_agent:
            # No agent — leave this for the user to register explicitly via
            # /api/discover/register. Auto-registering every running
            # container would pollute the registry with unrelated workloads.
            continue

        workspace = cand.inferred_workspace_folder or f"/workspace/{cand.name}"
        # Skip if the workspace is already registered (possible race where
        # container_id differs but the folder is the same).
        if await registry.get_by_workspace(workspace):
            continue

        await registry.add(
            workspace_folder=workspace,
            project_type=cand.inferred_project_type,
            project_name=cand.inferred_project_name,
            project_description=f"Auto-discovered container {cand.container_id}",
        )
        record = await registry.get_by_workspace(workspace)
        if record:
            # container_status UNKNOWN → RUNNING is a valid transition.
            await registry.update(
                record.id,
                container_id=cand.container_id,
                container_status="running",
                agent_status="idle",
                agent_port=cand.agent_port or 9100,
            )
        registered += 1
        logger.info(
            "Auto-discovered container %s (%s) at %s",
            cand.container_id,
            cand.inferred_project_name,
            workspace,
        )

    if registered > 0:
        logger.info("Auto-discovered %d new containers", registered)
    return registered
