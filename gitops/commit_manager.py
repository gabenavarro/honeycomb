"""Commit manager — stage, commit, and push across repos."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from gitops.runner import run_git

logger = logging.getLogger("gitops.commit_manager")


@dataclass
class CommitResult:
    """Result of a commit operation."""

    workspace_folder: str
    success: bool
    commit_hash: str = ""
    message: str = ""
    error: str = ""


async def stage_files(
    cwd: str,
    files: list[str] | None = None,
) -> tuple[bool, str]:
    """Stage files for commit. If files is None, stages all modified/untracked."""
    if files:
        rc, output = await run_git(["add", "--", *files], cwd)
    else:
        rc, output = await run_git(["add", "-A"], cwd)
    return rc == 0, output


async def get_staged_diff(cwd: str) -> str:
    """Get the diff of staged changes."""
    rc, output = await run_git(["diff", "--cached", "--stat"], cwd)
    return output if rc == 0 else ""


async def commit(
    cwd: str,
    message: str,
    author: str | None = None,
) -> CommitResult:
    """Create a commit with the staged changes."""
    cmd = ["commit", "-m", message]
    if author:
        cmd.extend(["--author", author])

    rc, output = await run_git(cmd, cwd)
    if rc != 0:
        return CommitResult(
            workspace_folder=cwd,
            success=False,
            error=output,
        )

    # Get the commit hash
    hash_rc, hash_output = await run_git(["rev-parse", "--short", "HEAD"], cwd)
    commit_hash = hash_output.strip() if hash_rc == 0 else ""

    return CommitResult(
        workspace_folder=cwd,
        success=True,
        commit_hash=commit_hash,
        message=message,
    )


async def push(
    cwd: str,
    remote: str = "origin",
    branch: str | None = None,
    set_upstream: bool = False,
) -> tuple[bool, str]:
    """Push commits to remote."""
    cmd = ["push", remote]
    if branch:
        cmd.append(branch)
    if set_upstream:
        cmd.insert(1, "-u")

    rc, output = await run_git(cmd, cwd, timeout=60)
    return rc == 0, output


async def stage_commit_push(
    cwd: str,
    message: str,
    files: list[str] | None = None,
    push_after: bool = True,
) -> CommitResult:
    """Stage, commit, and optionally push in one operation."""
    # Stage
    ok, stage_output = await stage_files(cwd, files)
    if not ok:
        return CommitResult(
            workspace_folder=cwd,
            success=False,
            error=f"Stage failed: {stage_output}",
        )

    # Check if there's anything to commit
    diff = await get_staged_diff(cwd)
    if not diff.strip():
        return CommitResult(
            workspace_folder=cwd,
            success=False,
            error="Nothing to commit (no staged changes)",
        )

    # Commit
    result = await commit(cwd, message)
    if not result.success:
        return result

    # Push
    if push_after:
        ok, push_output = await push(cwd)
        if not ok:
            result.error = f"Commit succeeded but push failed: {push_output}"

    return result


async def batch_commit(
    workspaces: list[str],
    message: str,
    files: list[str] | None = None,
    push_after: bool = True,
) -> list[CommitResult]:
    """Stage, commit, and push across multiple repos."""
    import asyncio

    results = await asyncio.gather(
        *[stage_commit_push(ws, message, files=files, push_after=push_after) for ws in workspaces],
        return_exceptions=True,
    )
    commit_results: list[CommitResult] = []
    for i, r in enumerate(results):
        if isinstance(r, CommitResult):
            commit_results.append(r)
        else:
            commit_results.append(
                CommitResult(
                    workspace_folder=workspaces[i],
                    success=False,
                    error=str(r),
                )
            )
    return commit_results


async def create_branch(
    cwd: str,
    branch_name: str,
    base: str = "HEAD",
) -> tuple[bool, str]:
    """Create and checkout a new branch."""
    rc, output = await run_git(["checkout", "-b", branch_name, base], cwd)
    return rc == 0, output


async def get_log(
    cwd: str,
    limit: int = 10,
    format_str: str = "%h %s (%cr)",
) -> list[str]:
    """Get recent commit log."""
    rc, output = await run_git(
        ["log", f"--max-count={limit}", f"--format={format_str}"],
        cwd,
    )
    if rc != 0:
        return []
    return [line for line in output.strip().split("\n") if line]
