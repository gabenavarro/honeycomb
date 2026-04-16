"""Tests for the repo scanner."""

from __future__ import annotations

import pytest

from gitops.repo_scanner import (
    RepoStatus,
    get_branch,
    get_last_commit,
    get_repo_url,
    get_working_tree_status,
    is_git_repo,
    scan_repo,
    scan_repos,
)


@pytest.fixture
def git_repo(tmp_path):
    """Create a temporary git repo for testing."""
    import subprocess
    repo = tmp_path / "test-repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True)
    # Create initial commit
    (repo / "README.md").write_text("# Test")
    subprocess.run(["git", "add", "README.md"], cwd=repo, capture_output=True)
    subprocess.run(["git", "commit", "-m", "initial commit"], cwd=repo, capture_output=True)
    return str(repo)


@pytest.fixture
def non_git_dir(tmp_path):
    """A directory that is not a git repo."""
    d = tmp_path / "not-a-repo"
    d.mkdir()
    return str(d)


class TestIsGitRepo:
    @pytest.mark.asyncio
    async def test_git_repo(self, git_repo: str) -> None:
        assert await is_git_repo(git_repo) is True

    @pytest.mark.asyncio
    async def test_non_git(self, non_git_dir: str) -> None:
        assert await is_git_repo(non_git_dir) is False


class TestGetBranch:
    @pytest.mark.asyncio
    async def test_default_branch(self, git_repo: str) -> None:
        branch = await get_branch(git_repo)
        assert branch in ("main", "master")

    @pytest.mark.asyncio
    async def test_non_git(self, non_git_dir: str) -> None:
        branch = await get_branch(non_git_dir)
        assert branch == "unknown"


class TestGetRepoUrl:
    @pytest.mark.asyncio
    async def test_no_remote(self, git_repo: str) -> None:
        url = await get_repo_url(git_repo)
        assert url is None


class TestGetWorkingTreeStatus:
    @pytest.mark.asyncio
    async def test_clean(self, git_repo: str) -> None:
        dirty, untracked, modified, staged = await get_working_tree_status(git_repo)
        assert dirty is False
        assert untracked == 0
        assert modified == 0
        assert staged == 0

    @pytest.mark.asyncio
    async def test_untracked_file(self, git_repo: str) -> None:
        import pathlib
        (pathlib.Path(git_repo) / "new_file.txt").write_text("hello")
        dirty, untracked, modified, staged = await get_working_tree_status(git_repo)
        assert dirty is True
        assert untracked == 1

    @pytest.mark.asyncio
    async def test_modified_file(self, git_repo: str) -> None:
        import pathlib
        (pathlib.Path(git_repo) / "README.md").write_text("modified")
        dirty, untracked, modified, staged = await get_working_tree_status(git_repo)
        assert dirty is True
        assert modified == 1

    @pytest.mark.asyncio
    async def test_staged_file(self, git_repo: str) -> None:
        import pathlib
        import subprocess
        (pathlib.Path(git_repo) / "README.md").write_text("staged change")
        subprocess.run(["git", "add", "README.md"], cwd=git_repo, capture_output=True)
        dirty, untracked, modified, staged = await get_working_tree_status(git_repo)
        assert dirty is True
        assert staged == 1


class TestGetLastCommit:
    @pytest.mark.asyncio
    async def test_has_commit(self, git_repo: str) -> None:
        msg, date = await get_last_commit(git_repo)
        assert msg == "initial commit"
        assert date != ""


class TestScanRepo:
    @pytest.mark.asyncio
    async def test_clean_repo(self, git_repo: str) -> None:
        status = await scan_repo(git_repo)
        assert status.workspace_folder == git_repo
        assert status.branch in ("main", "master")
        assert status.dirty is False
        assert status.last_commit_message == "initial commit"

    @pytest.mark.asyncio
    async def test_non_git(self, non_git_dir: str) -> None:
        status = await scan_repo(non_git_dir)
        assert status.workspace_folder == non_git_dir
        assert status.branch == ""

    @pytest.mark.asyncio
    async def test_dirty_repo(self, git_repo: str) -> None:
        import pathlib
        (pathlib.Path(git_repo) / "dirty.txt").write_text("dirty")
        status = await scan_repo(git_repo)
        assert status.dirty is True
        assert status.untracked_count == 1


class TestScanRepos:
    @pytest.mark.asyncio
    async def test_multiple(self, git_repo: str, non_git_dir: str) -> None:
        results = await scan_repos([git_repo, non_git_dir])
        assert len(results) == 2
