# Honeycomb v0.1.0 — Release Notes

**Date:** 2026-04-17

The first tagged release of Honeycomb — a local orchestrator for
multiple Claude Code + VSCode Dev Container environments. Twelve
milestones of work shipped serially to `main` over the preceding day;
this is the marker that says "the whole thing is shippable".

> Local-only by default. The hub binds to `127.0.0.1`. Every HTTP and
> WebSocket endpoint (except `/api/health`) is gated by a bearer token
> generated on first start. **Do not expose the hub beyond localhost
> without understanding the threat model in
> [SECURITY.md](../SECURITY.md).**

## Highlights

- **FastAPI hub** with SQLAlchemy-async + Alembic registry, structured
  logging, Prometheus metrics, and a bearer-token auth middleware on
  every endpoint.
- **React 19 + Vite 8 dashboard** with VSCode-inspired layout, xterm.js
  terminals, persistent PTYs with 5-minute grace reattach and 64 KiB
  scrollback replay, and a command palette backed by `cmdk`.
- **Worker agent (`hive-agent`)** that dials the hub over an
  authenticated WebSocket — no listener inside the container.
- **Three-path command relay** with structured 502 surfacing when all
  three paths fail.
- **A11y pass** via Radix primitives, global `:focus-visible`,
  `prefers-color-scheme`, ARIA progressbar roles on the resource
  monitor, and an ErrorBoundary around the editor pane.
- **Dashboard bones** landed in M10: Settings, Problems, Source
  Control, split editor, keybindings editor.

## What shipped, milestone by milestone

| Milestone | Theme                                                                                     | Tag                     |
| --------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| M0        | Secrets hygiene & baseline commit                                                         | `v0.0-baseline`         |
| M1        | Repo plumbing & CI (pre-commit, ruff, mypy, gitleaks, playwright)                         | `v0.1-tooling-ci`       |
| M2        | Config (`pydantic-settings`), structlog, Prometheus metrics, `logs:hub` WebSocket         | `v0.2-settings-logging` |
| M3        | Bearer-token auth on every HTTP + WebSocket endpoint                                      | `v0.3-auth`             |
| M4        | Worker transport rewrite — reverse-tunnel WebSocket, no `:9100` listener                  | `v0.4-reverse-tunnel`   |
| M5        | PTY command allowlist enum + bounded request fields                                       | `v0.5-pty-enum`         |
| M6        | Template + bootstrapper modernization (SandboxedEnv, non-root dev stage, no `curl \| sh`) | `v0.6-templates`        |
| M7        | SQLAlchemy async + Alembic migrations, explicit UPDATE allowlist                          | `v0.7-alembic`          |
| M8        | Dashboard a11y + Radix primitives + ErrorBoundary + `prefers-color-scheme`                | `v0.8-radix-a11y`       |
| M9        | `useLocalStorage`, listener try/catch, zod boundary validation, optimistic gitops         | `v0.9-state-refactor`   |
| M10       | VSCode bones — Settings, Problems, SCM, split editor, keybindings                         | `v0.10-vscode-bones`    |
| M11       | Testing depth — Playwright E2E, MSW handlers, security regressions                        | `v0.11-tests`           |
| M12       | Documentation, threat model, ARCHITECTURE.md, release notes                               | `v0.12-docs`            |

## Upgrading from pre-tag `main`

There is no upgrade path; `v0.1.0` is the first tag. Fresh checkouts
should:

1. Clone the repo, copy `.env.example` → `.env`, fill in
   `GITHUB_TOKEN`.
2. `pip install -e ./hub && pip install -e ./hive-agent`.
3. `cd dashboard && npm ci`.
4. Start the hub (`python hub/main.py`). Note the printed bearer token
   — save it in a password manager; it is also at
   `~/.config/honeycomb/token`.
5. Start the dashboard (`npm run dev` in `dashboard/`) and paste the
   token when prompted.

See [README.md](../README.md#quick-start) for the full walkthrough.

## Known limitations

- **No multi-tenant auth.** A single bearer token gates the whole hub;
  if you want per-user auth, that's out of scope for v0.1.
- **Docker integration tests not landed.** `testcontainers-python` was
  deferred from M11 — the three relay paths are covered by unit tests
  against mocks, and by Playwright smoke specs at the UI boundary.
  Real-Docker integration coverage is tracked for a follow-up.
- **Keybindings editor is JSON-only.** A visual keycap picker is a
  stretch goal; paste-a-JSON-blob ships now.
- **Single GPU exclusivity is enforced by soft warnings.** The host
  has one GPU; the hub flags a second `ml-cuda` container but the
  kernel is what actually picks who gets which VRAM slice.

## Thanks

Built with extensive help from Claude Code (Opus 4.7, 1M context) —
the plan, the implementation, the test suite, and these notes were
shepherded through the model's turn-taking workflow. Nothing replaces
a human review; this release notes file gets updated when the next
round of user testing lands feedback.
