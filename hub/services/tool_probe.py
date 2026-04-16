"""Detect availability of tools inside a running Docker container.

Currently: just `claude`. Kept as its own module so adding more probes
(uv, gh, docker-in-docker, etc.) doesn't bloat the commands router or
the registry.
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger("hub.tool_probe")


async def has_claude_cli(container_id: str, *, timeout: float = 5.0) -> bool:
    """Return True if `claude` resolves inside the container.

    We use `sh -lc 'command -v claude'` because `command -v` is POSIX
    (works in Alpine's ash) while `which` is not guaranteed. `-l`
    sources login profiles so any PATH changes installed via profile.d
    are picked up — otherwise a freshly-installed `@anthropic-ai/claude-code`
    can appear "missing" until the container is restarted.
    """
    cmd = [
        "docker",
        "exec",
        "-i",
        container_id,
        "sh",
        "-lc",
        "command -v claude >/dev/null 2>&1",
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError:
        logger.warning("docker binary missing — tool probes disabled")
        return False

    try:
        rc = await asyncio.wait_for(proc.wait(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        logger.info("tool_probe: has_claude_cli timed out after %ss for %s", timeout, container_id)
        return False

    return rc == 0
