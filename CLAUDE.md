# Claude Hive — Multi-Container Claude Code Orchestrator

## Project Overview

Claude Hive is a centralized command-and-control system for managing multiple Dockerized Claude Code + VSCode Dev Container environments. It provides a single web interface to dispatch work, monitor progress, review outputs, and manage GitHub operations across all containerized workspaces.

The system is built around **VSCode Dev Containers** — the user's existing workflow. Rather than replacing devcontainers with raw Docker management, Claude Hive enhances them with orchestration, automated bootstrapping, and centralized GitHub ops.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Hive Hub                       │
│                (FastAPI + WebSocket)                     │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐ │
│  │ Dashboard │  │ Git Ops  │  │ DevContainer Manager   │ │
│  │  (React)  │  │  Panel   │  │ (devcontainer CLI +    │ │
│  │          │  │          │  │  Docker SDK)            │ │
│  └──────────┘  └──────────┘  └────────────────────────┘ │
└──────────┬──────────┬──────────────┬────────────────────┘
           │          │              │
     ┌─────┴───┐ ┌───┴────┐  ┌─────┴──────┐
     │ Worker 1 │ │Worker 2│  │  Worker N   │
     │DevCont.  │ │DevCont.│  │  DevCont.   │
     │ ML/CUDA  │ │Web Dev │  │  CompBio    │
     │ Claude   │ │Claude  │  │  Claude     │
     │ Code CLI │ │Code CLI│  │  Code CLI   │
     └─────────┘ └────────┘  └────────────┘
```

### DevContainer Integration Model

Claude Hive works **with** the devcontainer ecosystem, not around it:

- **`devcontainer` CLI** (`@devcontainers/cli`) is the primary interface for container lifecycle: `devcontainer up`, `devcontainer exec`, `devcontainer read-configuration`
- **DevContainer Features** are used for bootstrapping: a custom `claude-hive` Feature installs Claude Code CLI, skills, hooks, and CLAUDE.md into any devcontainer on creation
- **`devcontainer.json` templates** per project type replace raw Dockerfiles as the provisioning unit — users can also use their existing `devcontainer.json` files
- **VSCode remains the IDE** — the hub doesn't replace VSCode, it orchestrates across VSCode windows
- **Docker SDK** is used for lower-level operations (inspecting containers, streaming logs, network queries) that the devcontainer CLI doesn't cover

### Core Components

1. **Hub Server** (`hub/`) — FastAPI backend exposing REST + WebSocket APIs
   - DevContainer lifecycle management via `devcontainer` CLI + Docker SDK for Python
   - Command relay to Claude Code CLI instances via `devcontainer exec`
   - GitHub operations aggregation (commits, PRs, reviews across repos)
   - Session and output streaming

2. **Dashboard** (`dashboard/`) — React/Vite frontend
   - Multi-pane terminal view for all active devcontainers
   - GitHub operations panel (cross-repo commits, PRs, reviews)
   - DevContainer provisioning wizard (select project type → auto-bootstrap)
   - Status monitoring and log aggregation

3. **Bootstrapper** (`bootstrapper/`) — DevContainer provisioning system
   - **DevContainer Feature** (`claude-hive-feature/`) — reusable Feature that installs Claude Code CLI + skills + hooks
   - Project-type `devcontainer.json` templates (ML/CUDA, Web Dev, CompBio, general)
   - Generates project-specific CLAUDE.md from Jinja2 templates + user description
   - Skill registry: curated lists of skills per project type (scientific-skills, superpowers, ECC)
   - Configures hooks, MCP servers, agents, and settings.json

4. **DevContainer Templates** (`templates/`) — `devcontainer.json` + Dockerfile per project type
   - `ml-cuda` — PyTorch, HuggingFace, Lightning, CUDA runtime, nvidia-container-toolkit
   - `web-dev` — Node.js, Python, common web frameworks
   - `compbio` — Bioinformatics tools, R, Python scientific stack
   - `base` — Minimal with Claude Code CLI + common tools

5. **Git Ops Module** (`gitops/`) — Centralized GitHub management
   - Cross-repo status dashboard
   - Batch commit, PR creation, and review workflows
   - PR review queue with inline commenting

## Tech Stack

- **Backend**: Python 3.12+, FastAPI, Docker SDK for Python, `devcontainer` CLI, `gh` CLI
- **Frontend**: React 19, Vite, xterm.js (terminal emulation), TanStack Query
- **Communication**: Multiplexed WebSocket (hub ↔ dashboard) with per-container channels + `problems`/`logs:hub`/`cmd:{id}`/`build:{path}` broadcast channels, persistent-PTY WebSockets at `/ws/pty/{record_id}`, three-path command relay (hub → workers: agent reverse-tunnel WebSocket at `/api/agent/connect` → `devcontainer exec` → `docker exec`), Docker SDK for inspection
- **Container Runtime**: Docker with devcontainer CLI for orchestration
- **Bootstrapping**: DevContainer Features + Jinja2 `SandboxedEnvironment` templates
- **Worker Agent**: `hive-agent` — lightweight Python process installed in the dev stage of every worker container. Since M4 it dials the hub over an authenticated WebSocket (`wss://hub/api/agent/connect?token=…&container=…`) rather than binding a local HTTP listener. Heartbeats, command dispatch, and output streaming all flow over the same socket.
- **Auth**: Bearer token gating every HTTP + WebSocket endpoint (M3). Token is generated on first start and persisted at `~/.config/honeycomb/token`. Dashboards pass it as a Bearer header and as `?token=` on WebSocket upgrades. GitHub PAT still handles `gh` CLI across containers.
- **Storage**: SQLAlchemy async + Alembic migrations over SQLite (M7); migrations apply on boot, legacy databases are backed up automatically. Settings overrides for `log_level`, `discover_roots`, `metrics_enabled` persist to `~/.config/honeycomb/settings.json` and layer on top of env-driven defaults.
- **Observability**: structlog with request-id + container-id binding; a subset of events fans out to the `logs:hub` WebSocket channel so dashboards can tail the hub. Prometheus `/metrics` endpoint exposes container/status/relay-path/PTY counts when `metrics_enabled`.

## Project Structure

```
claude-hive/
├── CLAUDE.md                    # This file
├── README.md                    # User-facing docs (quick start, API reference, contracts)
├── troubleshoot.md              # Symptom → Cause → Fix entries
├── .env.example                 # Environment variable template
├── hub/                         # FastAPI hub server
│   ├── main.py                  # App + lifespan + CLI (`hive` script)
│   ├── pyproject.toml
│   ├── routers/
│   │   ├── containers.py        # DevContainer CRUD + lifecycle
│   │   ├── commands.py          # Command relay (three-path: agent / devcontainer_exec / docker_exec)
│   │   ├── discover.py          # Unregistered workspace + running container discovery
│   │   ├── gitops.py            # GitHub operations
│   │   ├── pty.py               # Persistent PTY sessions (/ws/pty/{record_id})
│   │   └── ws.py                # Multiplexed WebSocket (/ws)
│   ├── services/
│   │   ├── autodiscovery.py     # Startup scan for containers with hive-agent
│   │   ├── claude_relay.py      # Command relay with three-path fallback
│   │   ├── devcontainer_manager.py  # devcontainer CLI + Docker SDK wrapper
│   │   ├── discovery.py         # Workspace + running-container enumeration
│   │   ├── health_checker.py    # Heartbeat timeout + state recovery
│   │   ├── pty_session.py       # PTY session registry + scrollback buffers
│   │   ├── registry.py          # SQLAlchemy async container registry (since M7)
│   │   ├── resource_monitor.py  # docker stats + nvidia-smi polling
│   │   └── tool_probe.py        # Probes for claude CLI, gh, etc. inside containers
│   ├── models/
│   │   └── schemas.py           # Pydantic models
│   ├── db/
│   │   ├── schema.py            # SQLAlchemy Core metadata (containers table)
│   │   ├── alembic.ini          # Alembic runtime config
│   │   ├── migrations/          # env.py + versions/ (baseline + future deltas)
│   │   └── migrations_runner.py # Auto-upgrade on boot; back up legacy DBs
│   └── tests/                   # pytest suite for hub
├── dashboard/                   # React + Vite + Tailwind frontend
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── index.css
│   │   ├── components/
│   │   │   ├── ActivityBar.tsx      # Leftmost activity rail (VSCode-style)
│   │   │   ├── CommandPalette.tsx   # Ctrl+K quick-switch/register
│   │   │   ├── ContainerList.tsx    # Primary sidebar list of containers
│   │   │   ├── ContainerTabs.tsx    # Tab group for opened containers
│   │   │   ├── GitOpsPanel.tsx      # Git Ops activity
│   │   │   ├── Provisioner.tsx      # New-container wizard (Discover + Manual)
│   │   │   ├── PtyPane.tsx          # Persistent PTY pane (Shell + Claude Interactive)
│   │   │   ├── ResourceMonitor.tsx  # CPU/memory/GPU sidebar
│   │   │   ├── StatusBadge.tsx
│   │   │   ├── StatusBar.tsx        # Bottom status bar
│   │   │   ├── TerminalInput.tsx    # Input with history + autocomplete
│   │   │   ├── TerminalPane.tsx     # Shell/Claude sub-tab container
│   │   │   └── XTermOutput.tsx      # xterm.js renderer with WebGL fallback
│   │   ├── hooks/
│   │   │   ├── useCommandOutput.ts      # cmd:{command_id} channel subscription
│   │   │   ├── useDiscovery.ts          # /api/discover polling
│   │   │   ├── useKeyboardShortcuts.ts
│   │   │   ├── useSessionStore.ts       # Per-(container, kind) localStorage transcripts
│   │   │   ├── useSmartPoll.ts
│   │   │   ├── useToasts.tsx
│   │   │   └── useWebSocket.ts          # Multiplexed /ws connection
│   │   └── lib/
│   │       ├── ansi.ts                  # ANSI parsing helpers
│   │       ├── api.ts                   # REST client
│   │       └── types.ts
│   ├── package.json
│   └── vite.config.ts
├── bootstrapper/                # Template + provisioning system
│   ├── provision.py             # Provisioning orchestrator
│   ├── claude-hive-feature/     # DevContainer Feature
│   │   ├── devcontainer-feature.json
│   │   └── install.sh
│   ├── templates/               # devcontainer.json + Dockerfile + CLAUDE.md per project type
│   │   ├── base/                # Also ships entrypoint.sh for our template Dockerfile path
│   │   ├── ml-cuda/
│   │   ├── web-dev/
│   │   └── compbio/
│   ├── skill_registries/        # Curated skill lists per project type
│   │   ├── base.json
│   │   ├── ml-cuda.json
│   │   ├── web-dev.json
│   │   └── compbio.json
│   ├── hooks/                   # Hook configs per project type
│   │   ├── default_hooks.json
│   │   ├── ml-cuda_hooks.json
│   │   ├── web-dev_hooks.json
│   │   └── compbio_hooks.json
│   └── tests/
├── hive-agent/                  # Lightweight worker-side client (pip-installable)
│   ├── pyproject.toml
│   ├── README.md
│   ├── hive_agent/
│   │   ├── __init__.py
│   │   ├── ws_client.py         # WebSocket client dialing the hub (since M4)
│   │   ├── command_runner.py    # Subprocess runner (used by ws_client)
│   │   ├── protocol.py          # Wire frames mirrored from hub/models/
│   │   └── cli.py               # `hive-agent start` entrypoint
│   └── tests/
├── gitops/                      # Git operations module
│   ├── runner.py                # Async git / gh subprocess wrappers
│   ├── repo_scanner.py          # Parallel repo status scanning
│   ├── pr_manager.py            # PR creation/review
│   ├── commit_manager.py        # Cross-repo commits
│   └── tests/
└── .claude/
    ├── settings.local.json
    ├── skills/                  # 8 custom skills (see table below)
    └── agents/                  # 4 custom agents (see table below)
```

## Coding Conventions

- **Python**: Use `uv` for dependency management. Type hints required. Pydantic v2 for all data models. Async-first (FastAPI async endpoints).
- **TypeScript/React**: Functional components only. Use TanStack Query for server state. Tailwind CSS for styling.
- **Docker**: Multi-stage builds (`base` → `dev` / `prod`). Pin base image versions. The `dev` stage runs as a non-root `app` user (M6). Prod stages inherit the same non-root default; explicitly re-assert `USER app` there before adding runtime entrypoints.
- **Testing**: pytest for Python, Vitest for TypeScript. Integration tests use testcontainers-python.
- **Git**: Conventional commits. Feature branches off `main`. PRs require passing CI.

## Key Design Decisions

- **DevContainer CLI as primary interface**: Use `devcontainer up/exec/read-configuration` for container lifecycle, not raw Docker commands. Docker SDK supplements for inspection and log streaming.
- **DevContainer Features for bootstrapping**: Claude Code CLI, skills, hooks, and configs are packaged as a reusable DevContainer Feature, installable via a single line in `devcontainer.json`.
- **WebSocket for real-time**: Terminal output and status updates stream via WebSocket, not polling. A single multiplexed `/ws` carries tagged frames for all containers; persistent-PTY sessions use dedicated `/ws/pty/{record_id}` sockets with 5-minute grace reattach and 64 KB scrollback replay.
- **Three-path command relay**: One-shot commands try, in order, the `hive-agent` reverse-tunnel WebSocket (hub dispatches `cmd_exec`, agent returns `done`), then `devcontainer exec` (only when a real `.devcontainer/devcontainer.json` exists), then `docker exec bash -lc` (with `sh -c` retry for Alpine). Each `CommandResponse` reports which path ran via `relay_path`; all three failing yields a 502 with a structured `{agent_error, devcontainer_error, docker_error}` body. Interactive work uses persistent PTYs instead.
- **Template-based provisioning**: New devcontainers are provisioned by composing `devcontainer.json` templates + CLAUDE.md Jinja2 templates + curated skill registries, not by cloning entire repos.
- **`gh` CLI for GitHub ops**: All GitHub operations use `gh` CLI (authenticated once on the hub, token shared to containers via Docker secrets).
- **VSCode-compatible**: The hub orchestrates across VSCode windows — users can still attach to any devcontainer with VSCode as normal. The dashboard is additive, not a replacement.
- **Discovery-first registration**: The "+ New" wizard defaults to a Discover tab that enumerates running Docker containers (marking "has_hive_agent" from AgentRegistry — the agent dials the hub over WebSocket) and workspace folders under `HIVE_DISCOVER_ROOTS` that contain a `.devcontainer/`. Manual template-based provisioning is the fallback, not the happy path.

## Community Resources — Used as Templates, Not Copied

All skills, agents, CLAUDE.md templates, and workflows are **written fresh** for Claude Hive, but modeled on patterns from community repos. Nothing is vendored or copied wholesale.

| Source Repo | What We Borrow (patterns, not code) |
|---|---|
| **everything-claude-code** | DevFleet multi-agent dispatch pattern, CLAUDE.md template structure (sections, conventions), hook lifecycle patterns (session persistence, quality gates), MCP server config format, skill registry organization |
| **superpowers** | SKILL.md frontmatter schema, subagent-driven-development coordinator/worker pattern, TDD RED-GREEN-REFACTOR enforcement, verification-before-completion discipline, brainstorming design-before-code flow |
| **claude-code-best-practice** | Command → Agent → Skill architecture, settings.json permission granularity, Agent Teams shared-task-list coordination, `devcontainer.json` best practices |
| **claude-scientific-skills** | SKILL.md structure (frontmatter + sections + references/ + scripts/), domain skill organization, `uv`-based dependency installation pattern |

### Custom Skills

Original skills for Claude Hive, structured like superpowers/ECC skills. All 8 live under `.claude/skills/`:

| Skill | Purpose | Informed By |
|---|---|---|
| `hive-orchestration` | Dispatch commands to multiple devcontainers, aggregate results, handle failures | ECC DevFleet, superpowers dispatching-parallel-agents |
| `devcontainer-provisioning` | Generate devcontainer.json + CLAUDE.md + skills for a new project given a type and description | ECC install.sh patterns, best-practice scaffolding |
| `cross-repo-gitops` | Scan repos, batch PRs, unified review queue, commit across repos | ECC code-review agent, superpowers finishing-a-development-branch |
| `ml-cuda-workflow` | PyTorch/Lightning/HuggingFace training patterns, CUDA debugging, experiment tracking | scientific-skills pytorch-lightning, ECC AI/ML patterns |
| `compbio-workflow` | Bioinformatics pipelines, single-cell analysis, protein modeling patterns | scientific-skills scanpy/biopython/esm/scvi-tools |
| `web-dev-workflow` | Full-stack patterns, API design, frontend component architecture | ECC frontend/backend patterns, best-practice Next.js template |
| `container-health` | Monitor resource usage, detect stuck containers, auto-restart policies | Original — no direct template |
| `project-bootstrap` | Interactive: ask project description → infer type → generate full .claude/ directory | superpowers brainstorming (design-before-code), ECC codebase-onboarding |

### Custom Agents

All 4 live under `.claude/agents/`:

| Agent | Purpose | Informed By |
|---|---|---|
| `hive-coordinator` | Top-level orchestrator: receives user intent, dispatches to appropriate devcontainer(s), merges results | ECC DevFleet coordinator, superpowers subagent-driven-development |
| `provisioner` | Given a project description, generates devcontainer.json, CLAUDE.md, skill selection, hook config | ECC architect agent, best-practice scaffolding |
| `gitops-reviewer` | Scans all tracked repos, surfaces PRs needing attention, drafts review comments | ECC code-reviewer agent, superpowers requesting-code-review |
| `container-doctor` | Diagnoses unhealthy containers: checks logs, resource usage, suggests fixes | superpowers systematic-debugging |

### CLAUDE.md Templates

Per-project-type templates in `bootstrapper/templates/<type>/claude.md.j2`, rendered by Jinja2 during provisioning:

| Template | Key Sections |
|---|---|
| `ml-cuda.md.j2` | Project overview, model architecture conventions, training pipeline patterns, experiment tracking (W&B/TensorBoard), CUDA 13.2/Blackwell guidelines, data loading conventions, checkpoint management |
| `web-dev.md.j2` | Project overview, API design conventions, frontend component patterns, state management, testing strategy, deployment pipeline, environment management |
| `compbio.md.j2` | Project overview, data pipeline conventions (FASTQ→BAM→VCF, scRNA-seq), analysis reproducibility requirements, figure generation standards, notebook conventions, database access patterns |
| `base.md.j2` | Project overview, coding conventions, testing strategy, git workflow — minimal, works for any project type |

## Authentication — Max Plan Subscription

<important>
Never set ANTHROPIC_API_KEY in docker-compose.yml, .env, entrypoint.sh, or
any container environment. This project uses Max plan subscription auth via
shared volume mount at /root/.claude. Setting an API key overrides the
subscription and incurs separate API charges.

The only place ANTHROPIC_API_KEY exists is in GitHub repository secrets for
the @claude GitHub Actions workflows that run in GitHub's cloud.
</important>

All containers share a single `claude-auth` Docker volume mounted at `/root/.claude`.
Login once interactively in any container, and all containers pick up the session:

```bash
docker compose run --rm <container> claude   # Follow OAuth flow
```

The entrypoint.sh actively guards against API key contamination — if `ANTHROPIC_API_KEY`
is set in the environment, it is unset with a warning before Claude Code starts.

### Usage Considerations at Scale

Max plan usage is shared between Claude (web/app) and Claude Code. With 7+ containers:
- Use Opus for complex work, Haiku for routine tasks (`/model` command)
- `/compact` proactively at 50% context to reduce token burn
- Don't run more than 2-3 active sessions simultaneously
- If you consistently hit limits, enable extra usage on your Max plan

## Environment Variables

- `GITHUB_TOKEN` — GitHub PAT for `gh` CLI (single account, required)
- `DOCKER_HOST` — Docker daemon socket (default: `unix:///var/run/docker.sock`)
- `HIVE_HOST` — Hub bind address (default: `127.0.0.1`, local-only)
- `HIVE_PORT` — Hub server port (default: `8420`)
- `HIVE_DISCOVER_ROOTS` — colon-separated host directories scanned by the Discover tab for unregistered `.devcontainer/` folders (default: `~/repos:~/projects:~/code:~/src:~/dev:~/workspace`, depth-bounded at 3)

## Scale Target

Designed for **7+ simultaneous devcontainers**. This drives several architectural choices:

- **Container registry** (SQLite via `aiosqlite`): persistent store mapping workspace folders, project types, container IDs, Git repo URLs, and status. At 7+ containers, in-memory tracking is fragile.
- **Multiplexed WebSocket**: a single WebSocket connection between dashboard and hub carries tagged frames from all containers (channel ID per container), rather than one connection per container. The hub demuxes `devcontainer exec` stdout/stderr streams into tagged frames.
- **Dashboard layout**: sidebar list with status badges (running/stopped/error) + a **focus pane** (full terminal for the selected container) + a **grid overview** (compact, read-only log tails for all others). Tab groups for switching between focus targets.
- **Resource monitoring**: the hub polls `docker stats` per container on a 5s interval and exposes CPU%, memory, and GPU utilization (via `nvidia-smi` where available) so the dashboard can surface contention.
- **Graceful degradation**: if a container becomes unresponsive, the hub marks it as errored and continues operating on the rest — no single container failure should block the hub.

## Important Constraints

- **Host machine**: 64-thread CPU, 256GB RAM, RTX 6000 Pro (Blackwell), CUDA 13.2. Hub runs natively on the host (not containerized).
- The hub accesses the Docker socket (`/var/run/docker.sock`) directly since it runs on the host.
- The `devcontainer` CLI (`@devcontainers/cli`) must be installed on the host. Install via `npm install -g @devcontainers/cli`.
- **GPU**: Single NVIDIA RTX 6000 Pro (Blackwell), CUDA 13.2 drivers. `nvidia-container-toolkit` required on host.
- GPU access in devcontainers via `"runArgs": ["--gpus=all"]` in `devcontainer.json`. Only ML/CUDA template containers get GPU access by default.
- **GPU exclusivity**: since there is one GPU, the hub tracks which container currently holds the GPU. The dashboard shows GPU ownership. Provisioner warns if a second GPU container is launched while one is already running. Containers without GPU needs (web dev, most compbio) should never request `--gpus`.
- GitHub token must have `repo`, `read:org`, and `workflow` scopes for full PR/review functionality.
- DevContainer Features require the container to be rebuilt to take effect — the hub should trigger `devcontainer up --build` when features change.
- Each devcontainer workspace folder must be known to the hub (tracked in a registry file or database) so `devcontainer exec --workspace-folder` can target the right container.
- **Containers are long-lived** — persisted and restarted, not ephemeral. The hub must handle container restart, re-attach, and state recovery. Named volumes for workspace data, Claude Code config (`~/.claude`), and skill caches to survive container rebuilds.
- **Multi-stage Dockerfiles**: user's projects use a `base` → `dev` / `prod` pattern. The `dev` target mounts the repo via volume (`-v $(pwd):/workspace/<project>`), the `prod` target bakes files in. DevContainer templates must use the `dev` target and configure `"workspaceMount"` + `"workspaceFolder"` in `devcontainer.json` to match this pattern. The bootstrapper should detect existing Dockerfiles with this pattern and generate compatible `devcontainer.json` rather than overwriting them.
- **Dev stage includes hive dependencies**: the `dev` Dockerfile target must install `hive-agent` (the lightweight worker-side client) so the container can communicate back to the hub. This is a small pip-installable package added to the dev stage, not the prod stage. Template Dockerfiles include a `RUN pip install hive-agent` (or `uv pip install`) line in the dev target.
