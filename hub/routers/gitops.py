"""Git operations REST endpoints — delegates to gitops module."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from gitops.commit_manager import stage_commit_push, CommitResult as GitCommitResult
from gitops.pr_manager import (
    PullRequest as GitPR,
    create_pr as git_create_pr,
    get_pr_detail as git_get_pr_detail,
    list_prs_across_repos,
    merge_pr as git_merge_pr,
    submit_review as git_submit_review,
)
from gitops.repo_scanner import RepoStatus as GitRepoStatus, scan_repos

logger = logging.getLogger("hub.routers.gitops")

router = APIRouter(prefix="/api/gitops", tags=["gitops"])


class CreatePRRequest(BaseModel):
    workspace_folder: str
    title: str
    body: str = ""
    base: str = "main"
    draft: bool = False


class CommitRequest(BaseModel):
    workspace_folder: str
    message: str
    files: list[str] | None = None
    push_after: bool = True


class ReviewRequest(BaseModel):
    action: str = "approve"
    body: str = ""


@router.get("/repos")
async def list_repos(request: Request) -> list[dict[str, Any]]:
    """Get git status for all registered repos."""
    registry = request.app.state.registry
    records = await registry.list_all()
    paths = [r.workspace_folder for r in records]

    statuses = await scan_repos(paths)
    return [
        {
            "workspace_folder": s.workspace_folder,
            "repo_url": s.repo_url,
            "branch": s.branch,
            "ahead": s.ahead,
            "behind": s.behind,
            "has_upstream": s.has_upstream,
            "dirty": s.dirty,
            "untracked_count": s.untracked_count,
            "modified_count": s.modified_count,
            "staged_count": s.staged_count,
            "open_pr_count": s.open_pr_count,
            "last_commit_message": s.last_commit_message,
            "last_commit_date": s.last_commit_date,
        }
        for s in statuses
    ]


@router.get("/prs")
async def list_prs(request: Request, state: str = "open") -> list[dict[str, Any]]:
    """List pull requests across all registered repos."""
    registry = request.app.state.registry
    records = await registry.list_all()
    paths = [r.workspace_folder for r in records]

    prs = await list_prs_across_repos(paths, state=state)
    return [
        {
            "repo": pr.repo,
            "number": pr.number,
            "title": pr.title,
            "author": pr.author,
            "state": pr.state,
            "created_at": pr.created_at,
            "updated_at": pr.updated_at,
            "url": pr.url,
            "review_status": pr.review_status,
            "additions": pr.additions,
            "deletions": pr.deletions,
            "changed_files": pr.changed_files,
        }
        for pr in prs
    ]


@router.post("/prs")
async def create_pr(req: CreatePRRequest) -> dict[str, Any]:
    """Create a pull request in a specific repo."""
    url = await git_create_pr(
        cwd=req.workspace_folder,
        title=req.title,
        body=req.body,
        base=req.base,
        draft=req.draft,
    )
    if url is None:
        raise HTTPException(400, "PR creation failed")
    return {"url": url, "status": "created"}


@router.get("/prs/{owner}/{repo}/{number}")
async def get_pr_detail(owner: str, repo: str, number: int) -> dict[str, Any]:
    """Get full PR details including comments."""
    detail = await git_get_pr_detail(owner, repo, number)
    if detail is None:
        raise HTTPException(404, f"PR {owner}/{repo}#{number} not found")
    return {
        "number": detail.number,
        "title": detail.title,
        "body": detail.body,
        "author": detail.author,
        "state": detail.state,
        "review_decision": detail.review_decision,
        "comments": detail.comments,
        "reviews": detail.reviews,
        "files": detail.files,
        "url": detail.url,
    }


@router.post("/prs/{owner}/{repo}/{number}/review")
async def submit_review(
    owner: str,
    repo: str,
    number: int,
    req: ReviewRequest,
) -> dict[str, Any]:
    """Submit a review on a PR (approve, request-changes, comment)."""
    try:
        success = await git_submit_review(
            owner, repo, number, action=req.action, body=req.body
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not success:
        raise HTTPException(400, "Review submission failed")
    return {"status": req.action, "pr": number}


@router.post("/prs/{owner}/{repo}/{number}/merge")
async def merge_pr(
    owner: str,
    repo: str,
    number: int,
    method: str = "squash",
    delete_branch: bool = True,
) -> dict[str, Any]:
    """Merge a PR (merge, squash, rebase)."""
    try:
        success = await git_merge_pr(
            owner, repo, number, method=method, delete_branch=delete_branch
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not success:
        raise HTTPException(400, "Merge failed")
    return {"status": "merged", "method": method, "pr": number}


@router.post("/commit")
async def commit_changes(req: CommitRequest) -> dict[str, Any]:
    """Stage, commit, and push changes in a repo."""
    result = await stage_commit_push(
        cwd=req.workspace_folder,
        message=req.message,
        files=req.files,
        push_after=req.push_after,
    )
    if not result.success:
        raise HTTPException(400, result.error)
    return {
        "success": True,
        "commit_hash": result.commit_hash,
        "message": result.message,
        "workspace_folder": result.workspace_folder,
    }
