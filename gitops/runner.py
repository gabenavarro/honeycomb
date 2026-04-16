"""Async subprocess runners for git and gh CLI commands."""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger("gitops.runner")


async def run_git(
    args: list[str],
    cwd: str,
    timeout: float = 15,
) -> tuple[int, str]:
    """Run a git command and return (returncode, combined_output)."""
    proc = await asyncio.create_subprocess_exec(
        "git",
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=cwd,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        return 1, f"git {' '.join(args)} timed out after {timeout}s"
    return proc.returncode or 0, stdout.decode()


async def run_gh(
    args: list[str],
    cwd: str | None = None,
    timeout: float = 30,
) -> tuple[int, str, str]:
    """Run a gh CLI command and return (returncode, stdout, stderr)."""
    cmd = ["gh", *args]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        return 1, "", f"gh {' '.join(args)} timed out after {timeout}s"
    return proc.returncode or 0, stdout.decode(), stderr.decode()
