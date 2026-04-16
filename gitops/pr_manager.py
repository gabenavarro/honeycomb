"""PR manager — create, list, review, and merge pull requests across repos."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from gitops.runner import run_gh, run_git

logger = logging.getLogger("gitops.pr_manager")


@dataclass
class PullRequest:
    """A pull request summary."""

    repo: str
    number: int
    title: str
    author: str
    state: str
    created_at: str
    updated_at: str
    url: str
    review_status: str = ""
    additions: int = 0
    deletions: int = 0
    changed_files: int = 0


@dataclass
class PRDetail:
    """Full PR details including body, comments, and review info."""

    number: int
    title: str
    body: str
    author: str
    state: str
    review_decision: str
    comments: list[dict]
    reviews: list[dict]
    files: list[dict]
    url: str


async def list_prs(
    cwd: str,
    state: str = "open",
    limit: int = 50,
) -> list[PullRequest]:
    """List PRs for a single repo."""
    rc, stdout, stderr = await run_gh(
        [
            "pr",
            "list",
            f"--state={state}",
            "--json=number,title,author,state,createdAt,updatedAt,url,reviewDecision,additions,deletions,changedFiles",
            f"--limit={limit}",
        ],
        cwd=cwd,
    )
    if rc != 0:
        logger.warning("PR list failed for %s: %s", cwd, stderr)
        return []

    try:
        prs_data = json.loads(stdout)
    except json.JSONDecodeError:
        return []

    # Derive repo name
    git_rc, repo_url = await run_git(["remote", "get-url", "origin"], cwd)
    repo = repo_url.strip().split("/")[-1].replace(".git", "") if git_rc == 0 else cwd

    return [
        PullRequest(
            repo=repo,
            number=pr["number"],
            title=pr["title"],
            author=pr.get("author", {}).get("login", "unknown"),
            state=pr["state"],
            created_at=pr["createdAt"],
            updated_at=pr["updatedAt"],
            url=pr["url"],
            review_status=pr.get("reviewDecision", ""),
            additions=pr.get("additions", 0),
            deletions=pr.get("deletions", 0),
            changed_files=pr.get("changedFiles", 0),
        )
        for pr in prs_data
    ]


async def list_prs_across_repos(
    workspaces: list[str],
    state: str = "open",
    limit: int = 50,
) -> list[PullRequest]:
    """List PRs across multiple repos, sorted by most recently updated."""
    import asyncio

    results = await asyncio.gather(
        *[list_prs(ws, state=state, limit=limit) for ws in workspaces],
        return_exceptions=True,
    )
    all_prs: list[PullRequest] = []
    for r in results:
        if isinstance(r, list):
            all_prs.extend(r)
        else:
            logger.warning("PR list failed: %s", r)

    all_prs.sort(key=lambda p: p.updated_at, reverse=True)
    return all_prs


async def get_pr_detail(
    owner: str,
    repo: str,
    number: int,
) -> PRDetail | None:
    """Get full PR details including comments and review info."""
    rc, stdout, stderr = await run_gh(
        [
            "pr",
            "view",
            str(number),
            "--repo",
            f"{owner}/{repo}",
            "--json",
            "number,title,body,author,state,reviewDecision,comments,reviews,files,url",
        ]
    )
    if rc != 0:
        logger.warning("PR detail failed for %s/%s#%d: %s", owner, repo, number, stderr)
        return None

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return None

    return PRDetail(
        number=data["number"],
        title=data["title"],
        body=data.get("body", ""),
        author=data.get("author", {}).get("login", "unknown"),
        state=data["state"],
        review_decision=data.get("reviewDecision", ""),
        comments=data.get("comments", []),
        reviews=data.get("reviews", []),
        files=data.get("files", []),
        url=data.get("url", ""),
    )


async def create_pr(
    cwd: str,
    title: str,
    body: str = "",
    base: str = "main",
    draft: bool = False,
) -> str | None:
    """Create a PR and return its URL."""
    cmd = ["pr", "create", "--title", title, "--body", body, "--base", base]
    if draft:
        cmd.append("--draft")

    rc, stdout, stderr = await run_gh(cmd, cwd=cwd)
    if rc != 0:
        logger.error("PR creation failed: %s", stderr)
        return None
    return stdout.strip()


async def submit_review(
    owner: str,
    repo: str,
    number: int,
    action: str = "approve",
    body: str = "",
) -> bool:
    """Submit a review on a PR. Action: approve, request-changes, comment."""
    if action not in ("approve", "request-changes", "comment"):
        raise ValueError(f"Invalid review action: {action}")

    cmd = ["pr", "review", str(number), "--repo", f"{owner}/{repo}", f"--{action}"]
    if body:
        cmd.extend(["--body", body])

    rc, _, stderr = await run_gh(cmd)
    if rc != 0:
        logger.error("Review failed for %s/%s#%d: %s", owner, repo, number, stderr)
        return False
    return True


async def merge_pr(
    owner: str,
    repo: str,
    number: int,
    method: str = "squash",
    delete_branch: bool = True,
) -> bool:
    """Merge a PR. Method: merge, squash, rebase."""
    if method not in ("merge", "squash", "rebase"):
        raise ValueError(f"Invalid merge method: {method}")

    cmd = ["pr", "merge", str(number), "--repo", f"{owner}/{repo}", f"--{method}"]
    if delete_branch:
        cmd.append("--delete-branch")

    rc, _, stderr = await run_gh(cmd)
    if rc != 0:
        logger.error("Merge failed for %s/%s#%d: %s", owner, repo, number, stderr)
        return False
    return True
