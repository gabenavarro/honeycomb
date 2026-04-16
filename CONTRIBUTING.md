# Contributing to Honeycomb

Honeycomb is a passion project. It moves in small, reviewable steps and
expects every change on `main` to be shippable. This document is short on
purpose — read it once, then follow the loop.

## The loop

One branch → merge to `main` → next branch. We do not work on two
milestones at once and we do not stack PRs. The roadmap lives in the plan
file the maintainer keeps under `~/.claude/plans/` and is broken into
milestones `M0`, `M1`, `M2`, … Each milestone is one branch named
`m<N>-<slug>` and lands with a tag `v0.<N>` on `main`.

For every milestone:

1. `git checkout main && git pull`
2. `git checkout -b m<N>-<slug>`
3. Implement the milestone's checklist. Commit often with
   [conventional-commit](https://www.conventionalcommits.org/)-style
   messages.
4. Push the branch and open a PR titled `M<N>: <milestone name>`.
5. Wait for CI green (see below).
6. Self-review using the maintainer's review loop; address findings in
   new commits on the same branch.
7. Merge to `main` with a merge commit (no squash, no rebase-merge —
   the milestone boundary stays visible in history). No force-push to
   `main`.
8. Tag the merge commit `v0.<N>`.
9. Delete the merged branch locally and on the remote.
10. Only then begin `M<N+1>` from step 1.

## Local setup

You will need Python 3.11+, Node.js 22+, Docker, and the devcontainer
CLI (`npm install -g @devcontainers/cli`). The root dev tooling installs
via:

```bash
pip install uv
uv pip install --system ruff mypy pytest pre-commit
pre-commit install
```

Per-package dev installs:

```bash
uv pip install --system -e "./hub[dev]"
uv pip install --system -e "./hive-agent[dev]"

cd dashboard && npm ci
```

## Style

- **Python.** `ruff check` + `ruff format`. `mypy` with the repo config.
  Tests live under `*/tests/`. `pytest-asyncio` is in auto mode.
- **TypeScript / React.** ESLint 9 flat config, Prettier, Vitest. Target
  is ES2023, strict TS.
- **Docker.** Multi-stage `base` → `dev` / `prod`. No `curl | sh`. Pin
  versions.
- **Commit messages.** Conventional prefix (`feat:`, `fix:`, `docs:`,
  `refactor:`, `test:`, `chore:`), imperative mood, explain the *why* in
  the body.

## Secrets

See [SECURITY.md](SECURITY.md). In short: nothing committable ever
contains a real token. `.env` is gitignored. `pre-commit` runs
`gitleaks`; CI runs it again on every PR.

## Running the hub locally after M3

The hub is gated by a bearer token. On first start it prints a token
banner and writes `~/.config/honeycomb/token` (mode `0600`). The
dashboard prompts for the token on first load; pass the same value via
`HIVE_AUTH_TOKEN` to any `hive-agent` containers that need to
heartbeat. Rotate by deleting the token file and restarting.

## Tests that must pass before merge

From M1 onward, CI runs these on every PR:

- `pre-commit run --all-files` (ruff, prettier, gitleaks, hygiene hooks)
- `ruff check` + `mypy` + `pytest` for `hub/` and `hive-agent/`
- `eslint`, `tsc -b --noEmit`, `prettier --check`, `vitest` for `dashboard/`
- `gitleaks-action` on the full diff
- `docker build --target dev` on the `base` template

If you need to add or change a CI job, do it in the same branch as the
work that motivated it.
