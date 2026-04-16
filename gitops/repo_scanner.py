"""Repo scanner — enumerate and check status of git repositories."""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime

from gitops.runner import run_gh, run_git

logger = logging.getLogger("gitops.repo_scanner")


@dataclass
class RepoStatus:
    """Status snapshot of a single git repository."""

    workspace_folder: str
    repo_url: str | None = None
    branch: str = ""
    ahead: int = 0
    behind: int = 0
    has_upstream: bool = True
    dirty: bool = False
    untracked_count: int = 0
    modified_count: int = 0
    staged_count: int = 0
    open_pr_count: int = 0
    last_commit_message: str = ""
    last_commit_date: str = ""
    last_checked: datetime = field(default_factory=datetime.now)


async def is_git_repo(path: str) -> bool:
    """Check if a path is inside a git repository."""
    rc, _ = await run_git(["rev-parse", "--git-dir"], path)
    return rc == 0


async def get_repo_url(path: str) -> str | None:
    """Get the remote origin URL for a repo."""
    rc, output = await run_git(["remote", "get-url", "origin"], path)
    return output.strip() if rc == 0 and output.strip() else None


async def get_branch(path: str) -> str:
    """Get the current branch name."""
    rc, output = await run_git(["rev-parse", "--abbrev-ref", "HEAD"], path)
    return output.strip() if rc == 0 else "unknown"


async def get_ahead_behind(path: str) -> tuple[int, int, bool]:
    """Get commits ahead/behind upstream.

    Returns (ahead, behind, has_upstream). `has_upstream=False` when the
    branch has no upstream configured — distinct from git failures.
    """
    # Probe upstream separately so we can distinguish "no upstream" from
    # other git errors.
    rc_up, _ = await run_git(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], path
    )
    if rc_up != 0:
        return 0, 0, False

    rc, output = await run_git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], path)
    if rc != 0:
        logger.debug("get_ahead_behind: rev-list failed for %s", path)
        return 0, 0, True
    parts = output.strip().split()
    if len(parts) == 2 and all(p.isdigit() for p in parts):
        return int(parts[0]), int(parts[1]), True
    logger.debug("get_ahead_behind: unexpected output for %s: %r", path, output)
    return 0, 0, True


async def get_working_tree_status(path: str) -> tuple[bool, int, int, int]:
    """Get working tree status: (dirty, untracked, modified, staged)."""
    rc, output = await run_git(["status", "--porcelain"], path)
    if rc != 0:
        return False, 0, 0, 0

    lines = [l for l in output.rstrip().split("\n") if l and len(l) >= 2]
    untracked = sum(1 for l in lines if l[:2] == "??")
    staged = sum(1 for l in lines if l[0] in "MADRC")
    modified = sum(1 for l in lines if l[1] in "MD" and l[:2] != "??")
    dirty = len(lines) > 0
    return dirty, untracked, modified, staged


async def get_last_commit(path: str) -> tuple[str, str]:
    """Get last commit message and date."""
    rc, output = await run_git(["log", "-1", "--format=%s|%ci"], path)
    if rc != 0 or not output.strip():
        return "", ""
    parts = output.strip().split("|", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return output.strip(), ""


async def count_open_prs(path: str) -> int:
    """Count open PRs for a repo via gh CLI.

    Returns 0 on any failure (gh missing, not authenticated, repo not a
    GitHub remote, unexpected output). Logs at debug so the common "no
    remote / no auth" case doesn't spam the hub.
    """
    try:
        rc, stdout, stderr = await run_gh(
            ["pr", "list", "--state=open", "--json=number", "--limit=100"],
            cwd=path,
        )
    except (FileNotFoundError, OSError) as exc:
        logger.debug("count_open_prs: gh not available for %s: %s", path, exc)
        return 0

    if rc != 0:
        logger.debug("count_open_prs: gh rc=%d for %s: %s", rc, path, (stderr or "").strip()[:200])
        return 0

    if not stdout.strip():
        return 0

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        logger.warning("count_open_prs: malformed JSON from gh for %s: %s", path, exc)
        return 0

    if not isinstance(data, list):
        logger.warning("count_open_prs: expected list, got %s for %s", type(data).__name__, path)
        return 0

    return len(data)


async def scan_repo(path: str) -> RepoStatus:
    """Perform a full status scan of a single repository."""
    if not await is_git_repo(path):
        return RepoStatus(workspace_folder=path)

    # Run independent queries in parallel
    (
        repo_url,
        branch,
        (ahead, behind, has_upstream),
        (dirty, untracked, modified, staged),
        (last_msg, last_date),
        open_prs,
    ) = await asyncio.gather(
        get_repo_url(path),
        get_branch(path),
        get_ahead_behind(path),
        get_working_tree_status(path),
        get_last_commit(path),
        count_open_prs(path),
    )

    return RepoStatus(
        workspace_folder=path,
        repo_url=repo_url,
        branch=branch,
        ahead=ahead,
        behind=behind,
        has_upstream=has_upstream,
        dirty=dirty,
        untracked_count=untracked,
        modified_count=modified,
        staged_count=staged,
        open_pr_count=open_prs,
        last_commit_message=last_msg,
        last_commit_date=last_date,
    )


async def scan_repos(paths: list[str]) -> list[RepoStatus]:
    """Scan multiple repos in parallel."""
    results = await asyncio.gather(
        *[scan_repo(p) for p in paths],
        return_exceptions=True,
    )
    statuses = []
    for r in results:
        if isinstance(r, RepoStatus):
            statuses.append(r)
        else:
            logger.warning("Scan failed: %s", r)
    return statuses
