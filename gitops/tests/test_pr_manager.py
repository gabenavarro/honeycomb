"""Tests for the PR manager.

Note: PR operations require GitHub authentication and a real repo,
so these tests focus on validation logic and error handling.
Integration tests with real repos would go in a separate suite.
"""

from __future__ import annotations

import pytest

from gitops.pr_manager import PullRequest, submit_review


class TestPullRequestDataclass:
    def test_create(self) -> None:
        pr = PullRequest(
            repo="my-repo",
            number=42,
            title="feat: add feature",
            author="testuser",
            state="OPEN",
            created_at="2026-03-01T00:00:00Z",
            updated_at="2026-03-20T00:00:00Z",
            url="https://github.com/user/my-repo/pull/42",
            review_status="REVIEW_REQUIRED",
            additions=50,
            deletions=10,
            changed_files=3,
        )
        assert pr.repo == "my-repo"
        assert pr.number == 42
        assert pr.changed_files == 3

    def test_defaults(self) -> None:
        pr = PullRequest(
            repo="r", number=1, title="t", author="a",
            state="OPEN", created_at="", updated_at="", url="",
        )
        assert pr.review_status == ""
        assert pr.additions == 0


class TestSubmitReviewValidation:
    @pytest.mark.asyncio
    async def test_invalid_action(self) -> None:
        with pytest.raises(ValueError, match="Invalid review action"):
            await submit_review("owner", "repo", 1, action="invalid")
