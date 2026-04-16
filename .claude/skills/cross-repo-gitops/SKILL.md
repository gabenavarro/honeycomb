---
name: cross-repo-gitops
description: Scan GitHub repos, manage PRs across repositories, maintain a unified review queue, and perform batch git operations via the hub's gitops API.
---

# Cross-Repo Git Operations

Manage GitHub workflows across all repositories tracked by Claude Hive from a single interface.

## When to Use This Skill

- Checking status of multiple repos at once (branch, dirty, ahead/behind)
- Reviewing pull requests across different repositories
- Creating PRs from devcontainers
- Performing batch git operations (commit, push) across repos
- Triaging a review queue spanning multiple projects

## Hub GitOps API

All git operations go through the hub at `http://127.0.0.1:8420`:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/gitops/repos` | Status of all registered repos |
| `GET /api/gitops/prs?state=open` | List PRs across all repos |
| `POST /api/gitops/prs` | Create a PR in a specific repo |
| `GET /api/gitops/prs/{owner}/{repo}/{number}` | Full PR detail with comments |
| `POST /api/gitops/prs/{owner}/{repo}/{number}/review` | Submit a review |

## Workflows

### Daily Status Check
1. `GET /api/gitops/repos` — see which repos are dirty, ahead/behind, have open PRs
2. Prioritize: dirty repos need commits, behind repos need pulls, open PRs need reviews
3. Address each in order

### PR Review Queue
1. `GET /api/gitops/prs?state=open` — unified list across all repos, sorted by most recent
2. Filter by repos you own vs. repos where you're a reviewer
3. For each PR: `GET /api/gitops/prs/{owner}/{repo}/{number}` to see diff, comments, review status
4. Submit review: `POST /api/gitops/prs/{owner}/{repo}/{number}/review` with `action=approve|request-changes|comment`

### Batch Commit Pattern
For changes spanning multiple repos (e.g., a shared library update):
1. Make changes in each devcontainer
2. For each repo, stage and commit via the container's Claude Code CLI
3. Push all repos
4. Create PRs in batch via `POST /api/gitops/prs`

### PR Creation from DevContainer
Inside a devcontainer, use `gh` CLI directly:
```bash
gh pr create --title "feat: add new feature" --body "Description of changes"
```
The hub's gitops panel will pick up the new PR automatically on next scan.

## Using gh CLI

The `gh` CLI is available in all devcontainers. Common commands:
```bash
gh pr list                           # List PRs in current repo
gh pr create --title "..." --body "..."  # Create PR
gh pr view 123                       # View PR details
gh pr review 123 --approve           # Approve a PR
gh pr review 123 --request-changes --body "..."  # Request changes
gh pr merge 123 --squash             # Merge with squash
gh issue list                        # List issues
gh repo view                         # View repo info
```

## Best Practices

- Use conventional commit messages: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Keep PRs focused — one logical change per PR
- Add descriptive PR bodies: what changed, why, how to test
- Review PRs within 24 hours to avoid blocking others
- Use `gh pr merge --squash` for clean history on main
- Check repo status before starting new work to avoid conflicts
- For related changes across repos, link PRs in their descriptions
