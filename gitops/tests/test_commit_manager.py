"""Tests for the commit manager."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from gitops.commit_manager import (
    commit,
    create_branch,
    get_log,
    get_staged_diff,
    stage_commit_push,
    stage_files,
)


@pytest.fixture
def git_repo(tmp_path):
    """Create a temporary git repo with an initial commit."""
    repo = tmp_path / "test-repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True)
    (repo / "README.md").write_text("# Test")
    subprocess.run(["git", "add", "README.md"], cwd=repo, capture_output=True)
    subprocess.run(["git", "commit", "-m", "initial commit"], cwd=repo, capture_output=True)
    return str(repo)


class TestStageFiles:
    @pytest.mark.asyncio
    async def test_stage_specific_files(self, git_repo: str) -> None:
        (Path(git_repo) / "new.txt").write_text("hello")
        ok, _ = await stage_files(git_repo, ["new.txt"])
        assert ok is True

    @pytest.mark.asyncio
    async def test_stage_all(self, git_repo: str) -> None:
        (Path(git_repo) / "a.txt").write_text("a")
        (Path(git_repo) / "b.txt").write_text("b")
        ok, _ = await stage_files(git_repo)
        assert ok is True


class TestGetStagedDiff:
    @pytest.mark.asyncio
    async def test_no_staged(self, git_repo: str) -> None:
        diff = await get_staged_diff(git_repo)
        assert diff.strip() == ""

    @pytest.mark.asyncio
    async def test_with_staged(self, git_repo: str) -> None:
        (Path(git_repo) / "new.txt").write_text("hello")
        await stage_files(git_repo, ["new.txt"])
        diff = await get_staged_diff(git_repo)
        assert "new.txt" in diff


class TestCommit:
    @pytest.mark.asyncio
    async def test_commit_staged(self, git_repo: str) -> None:
        (Path(git_repo) / "new.txt").write_text("hello")
        await stage_files(git_repo, ["new.txt"])
        result = await commit(git_repo, "test: add new file")
        assert result.success is True
        assert result.commit_hash != ""
        assert result.message == "test: add new file"

    @pytest.mark.asyncio
    async def test_commit_nothing_staged(self, git_repo: str) -> None:
        result = await commit(git_repo, "empty commit")
        assert result.success is False


class TestStageCommitPush:
    @pytest.mark.asyncio
    async def test_commit_no_push(self, git_repo: str) -> None:
        (Path(git_repo) / "file.txt").write_text("content")
        result = await stage_commit_push(git_repo, "test: add file", push_after=False)
        assert result.success is True
        assert result.commit_hash != ""

    @pytest.mark.asyncio
    async def test_nothing_to_commit(self, git_repo: str) -> None:
        result = await stage_commit_push(git_repo, "nothing", push_after=False)
        assert result.success is False
        assert "Nothing to commit" in result.error


class TestCreateBranch:
    @pytest.mark.asyncio
    async def test_create_branch(self, git_repo: str) -> None:
        ok, _ = await create_branch(git_repo, "feature/test")
        assert ok is True

        # Verify we're on the new branch
        from gitops.repo_scanner import get_branch

        branch = await get_branch(git_repo)
        assert branch == "feature/test"


class TestGetLog:
    @pytest.mark.asyncio
    async def test_log(self, git_repo: str) -> None:
        log = await get_log(git_repo, limit=5)
        assert len(log) >= 1
        assert "initial commit" in log[0]

    @pytest.mark.asyncio
    async def test_log_after_commits(self, git_repo: str) -> None:
        (Path(git_repo) / "a.txt").write_text("a")
        await stage_files(git_repo, ["a.txt"])
        await commit(git_repo, "add a")
        (Path(git_repo) / "b.txt").write_text("b")
        await stage_files(git_repo, ["b.txt"])
        await commit(git_repo, "add b")

        log = await get_log(git_repo, limit=3)
        assert len(log) == 3
        assert "add b" in log[0]
        assert "add a" in log[1]
