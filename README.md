# Honeycomb a Claude docker hive orchestrator

A centralized command-and-control system for managing multiple Claude Code + VSCode Dev Container environments from a single interface.

```
┌─────────────────────────────────────────────────┐
│              Claude Hive Hub                     │
│           (FastAPI + WebSocket)                  │
│                                                  │
│  Dashboard  │  Git Ops  │  Container Manager     │
└──────┬──────────┬──────────────┬────────────────┘
       │          │              │
  ┌────┴──┐  ┌───┴───┐   ┌─────┴─────┐
  │ML/CUDA│  │Web Dev│   │  CompBio  │
  │Claude │  │Claude │   │  Claude   │
  │Code   │  │Code   │   │  Code    │
  └───────┘  └───────┘   └──────────┘
```

## Prerequisites

| Requirement | Version | Install |
|---|---|---|
| Python | 3.11+ | System or conda |
| Node.js | 22+ | `nvm install 22` or system |
| Docker | 24+ | [docs.docker.com](https://docs.docker.com/engine/install/) |
| devcontainer CLI | latest | `npm install -g @devcontainers/cli` |
| Git | 2.30+ | System |
| gh CLI | 2.0+ | `sudo apt install gh` or [cli.github.com](https://cli.github.com/) |

**GPU containers** (ML/CUDA template) additionally require:
- NVIDIA drivers with CUDA 13.2+
- [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

## Quick Start

### 1. Clone and install

```bash
git clone <this-repo> claude-hive
cd claude-hive

# Install the hub server
pip install -e ./hub

# Install the hive-agent (worker-side client)
pip install -e ./hive-agent

# Install the dashboard
cd dashboard && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:
```bash
GITHUB_TOKEN=ghp_your-github-pat     # Required — scopes: repo, read:org, workflow

# Optional, for specific project types:
WANDB_API_KEY=...                      # ML experiment tracking
HF_TOKEN=hf_...                       # HuggingFace gated models
NCBI_API_KEY=...                       # CompBio database access
```

> **Do NOT set `ANTHROPIC_API_KEY`** in `.env` or anywhere on the host.
> Claude Hive uses your Max plan subscription via interactive login (see Step 4).

### 3. Start the hub and dashboard

Open **two terminals**:

**Terminal 1 — Hub server:**
```bash
python hub/main.py
```

The hub starts on `http://127.0.0.1:8420`. It will check for prerequisites and warn about any missing tools.

> **Bearer token.** On first start the hub prints a banner with a generated token and writes it to `~/.config/honeycomb/token` (mode `0600`). Every HTTP and WebSocket endpoint (except `/api/health`) requires this token. Override with `HIVE_AUTH_TOKEN=…` in your environment — useful for CI. See [SECURITY.md](SECURITY.md) for the full auth model.

**Terminal 2 — Dashboard:**
```bash
cd dashboard
npm run dev
```

Open `http://127.0.0.1:5173` in your browser. The dashboard will prompt for the bearer token from Terminal 1; it's stored in `localStorage` and attached to every request.

### 4. Authenticate Claude (one-time)

Claude Hive uses your **Max plan subscription**, not an API key. All containers share a single auth session via a Docker volume.

**Option A — Via the dashboard:**
1. Click **"+ New"** to create your first container (see Step 5)
2. Once running, open its terminal in the dashboard
3. Run `claude` and follow the OAuth login flow in your browser

**Option B — Via command line:**
```bash
# Start any devcontainer
devcontainer up --workspace-folder /path/to/your/project

# Login interactively
devcontainer exec --workspace-folder /path/to/your/project -- claude
# Complete the browser OAuth flow
# Press Ctrl+C after login succeeds
```

The credentials are stored in the shared `claude-auth` Docker volume. Every container mounts this volume, so you only log in once.

**Verify auth:**
```bash
# Should show "subscription" auth, NOT "api_key"
curl http://127.0.0.1:8420/api/auth/status
```

### 5. Create your first devcontainer

**Via the dashboard** (recommended):
1. Click **"+ New"** in the top-right corner
2. Fill in:
   - **Project Name**: e.g., "My ML Experiment"
   - **Workspace Folder**: absolute host path, e.g., `/home/you/projects/my-experiment`
   - **Project Type**: choose ML/CUDA, Web Dev, CompBio, or Base
   - **Description**: one-liner about the project
3. Click **Create** — the bootstrapper generates `devcontainer.json`, `CLAUDE.md`, skills, hooks, and starts the container

**Via the API:**
```bash
curl -X POST http://127.0.0.1:8420/api/containers \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_folder": "/home/you/projects/my-experiment",
    "project_type": "ml-cuda",
    "project_name": "My ML Experiment",
    "project_description": "Fine-tuning a transformer on domain data",
    "auto_provision": true,
    "auto_start": true
  }'
```

**Via the bootstrapper directly** (provision without starting):
```bash
python -c "
from bootstrapper.provision import provision
from pathlib import Path
provision(
    workspace=Path('/home/you/projects/my-experiment'),
    project_type='ml-cuda',
    project_name='My ML Experiment',
    project_description='Fine-tuning a transformer on domain data',
)
"
```

## Project Types

| Type | Template | GPU | Key Dependencies |
|---|---|---|---|
| `base` | General purpose | No | Python 3.12, Node.js 22, gh CLI, uv |
| `ml-cuda` | Machine learning | Yes | PyTorch, HuggingFace, Lightning, CUDA 13.2 |
| `web-dev` | Full-stack web | No | Node.js, FastAPI, Playwright, pnpm |
| `compbio` | Computational biology | No | scanpy, BioPython, RDKit, pysam, scvi-tools |

Each type provisions:
- A `devcontainer.json` with appropriate settings, ports, and volumes
- A `Dockerfile` (multi-stage: `base` → `dev` / `prod`)
- A tailored `CLAUDE.md` with domain-specific coding conventions
- Curated skills and MCP server configs
- Default hooks for session lifecycle

## Dashboard Guide

### Layout

Cursor/VSCode-inspired: narrow activity bar on the left, a primary
sidebar whose content is driven by the active activity, an editor area
with container tabs (each tab holds its own Shell + Claude sub-tabs), a
resources sidebar on the right, and a status bar across the bottom.

```
┌─┬────────────┬───────────────────────────────────┬──────────┐
│A│  Primary   │  [gnbio ×] [ml-exp ×] [web-app]   │ Resources│
│c│  sidebar   │ ─────────────────────────────────── │   CPU    │
│t│            │  [ Shell ] [ Claude ]              │   Mem    │
│i│  - ML Exp  │ ─────────────────────────────────── │   GPU    │
│v│  - Web App │  $ whoami                          │          │
│ │  - Gene An │  root                              │          │
│B│            │  $ _                               │          │
│a│            │                                   │          │
│r│            │                                   │          │
├─┴────────────┴───────────────────────────────────┴──────────┤
│  ● hub  v0.1.0  3/5 running  GPU: ML Exp   Ctrl+K ...        │
└──────────────────────────────────────────────────────────────┘
```

- **Activity bar** (leftmost rail): `Containers`, `Git Ops`, `⌘K` palette,
  `Settings`. Badge numbers show container + PR counts.
- **Primary sidebar**: whatever the active activity shows — container
  list (with start/stop/remove + `+ New`) or Git Ops panel. Toggle with
  `Ctrl+B`.
- **Container tabs**: opening a container from the sidebar adds a tab;
  middle-click or the × icon closes it (closing only removes the tab —
  the container stays registered). `Ctrl+1..9` focuses the Nth tab.
- **Shell / Claude sub-tabs**: every opened container carries two parallel
  sessions. Switching between them preserves lines, typed drafts, and
  streaming indicators — per-container, per-kind. Transcripts persist to
  `localStorage` across reloads.
- **Resources sidebar** (right): CPU/memory/GPU for the focused tab.
  Toggle with `Ctrl+\``.
- **Status bar**: WebSocket connection, version, running/registered
  counts, current GPU owner, shortcut cheat-sheet.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Command palette (quick-switch container, register, switch activity) |
| `Ctrl+B` | Toggle primary sidebar |
| `` Ctrl+` `` | Toggle resources sidebar |
| `Ctrl+W` | Close active container tab |
| `Ctrl+1..9` | Focus Nth open container tab |
| `Ctrl+Shift+C` | Containers activity |
| `Ctrl+Shift+G` | Git Ops activity |

### Terminal renderer

The output pane is [xterm.js](https://xtermjs.org/) — the same terminal
that powers VSCode, Hyper, and Tabby. It renders real ANSI:

- Colors from `ls --color`, `pytest`, `grep --color`, diff tools, etc.
  pass through verbatim — we don't strip or re-wrap them.
- Cursor-up / carriage-return redraws work, so pip's progress bars,
  `tqdm`, and any CLI spinner render in place instead of scrolling.
- Hyperlinks (http/https in output) are clickable.

**Renderer**: WebGL by default (~9× faster than DOM, used by VSCode).
Falls back silently to the DOM renderer when `WebGL2RenderingContext`
isn't available (some WSL2 GPU configs). No user action required — the
probe happens at terminal-mount time.

**Scrollback**: 10,000 lines per terminal (independent of the session
store's 2,000-line persisted cap).

**Waiting animations**: while a command is in flight, the bottom row
shows an animated [braille-dots spinner](https://www.npmjs.com/package/cli-spinners)
with a context-aware label ("Running in *container*…", "Waiting for
Claude (*container*)…"). The first output frame erases the spinner
before appending, so animations don't leave artifacts.

### Terminal sessions

Each container tab has a **Shell** sub-tab (raw shell via the current
relay path) and a **Claude** sub-tab (`claude -p …` wrapping). Sessions:

- Are keyed `(container_id, "shell" | "claude")`, stored under
  `hive:session:v3:...` in `localStorage`.
- Cap at 2000 lines each (ring buffer). Use the trash icon in the
  session toolbar to clear. **History survives Clear** so arrow-up
  recall still works.
- Use the clipboard icon to copy the full transcript (handy for Claude
  conversations you want to save).
- Show an amber streaming dot in the tab header while a command is
  in-flight, a gray dot once it completes.

#### History and autocomplete

- **↑ / ↓** walk through session history (bash-style, most-recent
  first). The live draft is stashed on entry and restored by `↓` past
  the newest entry or `Esc`. Consecutive duplicates are collapsed.
  History survives across browser reloads and persists per
  `(container, kind)` — Shell history is independent of Claude.
- **Tab** accepts the highlighted autocomplete suggestion. Suggestions
  are ranked: session history matches first, then a small built-in set
  appropriate to the tab (`ls -la`, `git status`, etc. for Shell;
  `Summarize the structure of this repo.`, etc. for Claude).
- **Esc** dismisses the suggestion list or restores the stashed draft.
- The dropdown only shows when the user has typed something and there
  is at least one match — empty-input focus stays silent.

### Claude CLI availability

The hub probes every registered container for `claude` on PATH at
registration time (and after a fresh install). The result lives on the
container record as `has_claude_cli`. When the user switches to the
Claude sub-tab of a container missing the CLI, the dashboard shows an
**install gate** instead of the input — a single button runs
`npm install -g @anthropic-ai/claude-code` via `docker exec` and
re-probes on completion. If the container has no `npm` either, the
install short-circuits with a readable message (install Node.js first
via `apk add nodejs npm` or `apt-get install nodejs npm`).

Related endpoint: `POST /api/containers/{id}/install-claude-cli`.

### Adding containers via Discover

The "+ New" wizard opens on the **Discover** tab by default. The hub scans
two sources and shows only entries not yet registered:

- **Running containers** — every Docker container currently running. Each
  row shows the inferred project name, image tag, inferred project type,
  and whether `hive-agent` is already reachable on port 9100. Click
  **Register** to link it in place (state transitions straight to
  `running`, no rebuild).
- **Workspaces ready to register** — folders under
  `HIVE_DISCOVER_ROOTS` that contain a `.devcontainer/devcontainer.json`.
  **Add** registers immediately with the inferred type; **Customize…**
  prefills the Manual tab so you can tweak name, type, or description
  before submitting.

The Manual tab is still available for one-off cases where the workspace
isn't in a discover root, and is the path that invokes the full provision
+ build flow.

### Container Status Indicators

| Badge | Meaning |
|---|---|
| `running` (green) | Container is up and healthy |
| `stopped` (gray) | Container exists but is not running |
| `starting` (yellow) | Container is being built or started |
| `error` (red) | Container failed or is unresponsive |
| `GPU` (amber) | Container has GPU access |
| Agent `idle` (green) | hive-agent ready, no commands running |
| Agent `busy` (blue) | hive-agent is executing a command |
| Agent `unreachable` (gray) | hive-agent missed 3+ heartbeats |

## Hub API Reference

The hub runs at `http://127.0.0.1:8420`. All endpoints are under `/api/`.

### Containers
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/containers` | List all containers |
| `POST` | `/api/containers` | Register + provision + start |
| `GET` | `/api/containers/{id}` | Get container details |
| `PATCH` | `/api/containers/{id}` | Update container fields |
| `DELETE` | `/api/containers/{id}` | Remove container |
| `POST` | `/api/containers/{id}/start` | Start a stopped container |
| `POST` | `/api/containers/{id}/stop` | Stop a running container |
| `POST` | `/api/containers/{id}/rebuild` | Rebuild (devcontainer up --build) |
| `GET` | `/api/containers/{id}/resources` | CPU/memory/GPU stats |

### Commands
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/containers/{id}/commands` | Execute a command |
| `GET` | `/api/containers/{id}/commands/{cmd_id}` | Get output |
| `GET` | `/api/containers/{id}/commands/{cmd_id}/stream` | Stream output |
| `POST` | `/api/containers/{id}/commands/{cmd_id}/kill` | Kill command |

### Git Ops
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/gitops/repos` | Status of all repos |
| `GET` | `/api/gitops/prs?state=open` | PRs across all repos |
| `POST` | `/api/gitops/prs` | Create a PR |
| `GET` | `/api/gitops/prs/{owner}/{repo}/{number}` | PR detail |
| `POST` | `/api/gitops/prs/{owner}/{repo}/{number}/review` | Submit review |
| `POST` | `/api/gitops/prs/{owner}/{repo}/{number}/merge` | Merge PR |
| `POST` | `/api/gitops/commit` | Stage + commit + push |

### Discovery
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/discover` | Both workspaces + containers + discover_roots |
| `GET` | `/api/discover/workspaces` | Unregistered `.devcontainer/` folders under configured roots |
| `GET` | `/api/discover/containers` | Unregistered running Docker containers (probes hive-agent) |
| `POST` | `/api/discover/register` | Register a discovered candidate (by workspace or container_id) |

### System
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Hub health check |
| `GET` | `/api/auth/status` | Auth status per container (parallel, bounded at 20s) |
| `POST` | `/api/heartbeat` | Heartbeat from hive-agent |
| `POST` | `/api/events` | Event from hive-agent |
| `WS` | `/ws` | Multiplexed WebSocket |

## Contracts

### Terminal transports (when to use which)

Three transports, chosen by the pane the user is in:

| Pane | Transport | Best for |
|---|---|---|
| **Shell** sub-tab | Persistent PTY via WebSocket | Interactive work. `cd`, env vars, `vim`, `htop`, bash history — all real. |
| **Claude → Interactive** | Persistent PTY running `claude` | Claude REPL. `/login`, `/resume`, `/compact`, `/clear` all work. |
| **Claude → Quick** | One-shot `docker_exec` (below) | Short `claude -p "..."` prompts captured to the localStorage transcript. Scriptable. |
| Programmatic `/api/containers/{id}/commands` | One-shot relay (three-way) | External tools posting commands. Unchanged. |

The persistent PTY is exposed at `/ws/pty/{record_id}` — see the
"WebSocket PTY protocol" subsection below.

### WebSocket PTY protocol

Client → Server frames:

| Form | Meaning |
|---|---|
| binary | stdin bytes (preferred for high-throughput paste) |
| text `d<utf8>` | stdin as UTF-8 text |
| text `r<cols>,<rows>` | resize, e.g. `r120,40` |
| text `p` | ping |
| text `k` | explicit kill (bypass grace period) |

Server → Client frames:

| Form | Meaning |
|---|---|
| binary | raw PTY output → `term.write()` |
| text `sattached` | new session is live |
| text `sreattached:<seconds>` | existing session reattached after N seconds detached |
| text `sreplay:<N>` | next binary frame is an N-byte scrollback replay |
| text `sclosed:<reason>` | session closed; no further frames |
| text `spong` | reply to ping |

**Session identity** is `(record_id, label)`. The dashboard stores one
`label` per tab in `sessionStorage` so reloads reattach to the same PTY.
A second client attaching to the same label displaces the first
(single-writer discipline). **Grace period**: disconnecting without
sending `k` keeps the PTY alive for 5 minutes — long enough to outlast
Chrome's background-tab suspension. **Scrollback**: each session keeps
a 64 KB ring buffer server-side, replayed on reattach so the user sees
the tail of what happened while they were gone.

### Command relay paths

The hub tries three paths for each command, in order, and reports which
one delivered it in `CommandResponse.relay_path`:

1. **`agent`** — POST to `hive-agent`'s `/exec` inside the container. Only
   works when the agent port (9100) answered a recent health check.
   Output streams over the `cmd:{command_id}` WebSocket channel; response
   is async.
2. **`devcontainer_exec`** — only when the workspace folder has a real
   `.devcontainer/devcontainer.json`. Runs via `devcontainer exec
   --workspace-folder <path>`. Synchronous; full `stdout` / `stderr` /
   `exit_code` returned inline.
3. **`docker_exec`** — falls back to `docker exec -i <cid> bash -lc <cmd>`
   (retrying with `sh -c` if the container has no bash). Works for any
   container the hub can see — including ones started by plain
   `docker run` or VSCode-native devcontainers where the CLI isn't
   available. Synchronous; inline output.

All three paths fail → 502 with a structured
`{agent_error, devcontainer_error, docker_error}` body and the record
is transitioned to `error`.

### Command output streaming (`cmd:{command_id}`)

When the dashboard dispatches a command, the hub forwards it to the
container's `hive-agent`. As each stdout/stderr line is produced, the agent
posts a `command_output` event to the hub, which rebroadcasts it on the
WebSocket channel `cmd:{command_id}`:

```json
{"channel": "cmd:abc12345", "event": "command_output",
 "data": {"command_id": "abc12345", "stream": "stdout"|"stderr"|"exit",
          "text": "line\n", "ts": "2026-04-14T12:00:00Z"}}
```

A final `{stream: "exit", text: "<returncode>"}` frame marks completion.
Subscribe before or immediately after calling `POST /api/containers/{id}/commands`.
`exec_via_devcontainer` fallback paths return the full output inline in
`CommandResponse` rather than streaming.

### Build output streaming (`build:{workspace_folder}`)

During `devcontainer up`, the hub broadcasts each line of the build to
`build:{workspace_folder}`. The dashboard Provisioner subscribes before
firing the POST so it can show real progress instead of a placeholder.

### Container state machine

Transitions enforced by the registry:

- `unknown → {starting, running, stopped, error}` (discovery)
- `starting → {running, error, stopped, unknown}`
- `running → {stopped, starting, error, unknown}`
- `stopped → {starting, running, error, unknown}`
- `error → {starting, stopped, unknown}` (no direct `error → running`)

Same-state writes are dropped; violations raise `InvalidStateTransition`
which the API surfaces as 409.

### GPU exclusivity

The host has a single GPU. A second `ml-cuda` container created while
another ml-cuda is `running` is rejected with 409 unless `force_gpu=true`
is set in the POST body. The response includes the current owner.

### WebSocket broadcast semantics

Broadcasts run concurrently (`asyncio.gather`) with a 2 s per-client
timeout. Clients that fail to accept a frame within that window are
disconnected and cleaned up — a single slow/hung dashboard tab cannot
delay delivery to the rest of the fleet.

### Skills manifest

`bootstrapper/provision.py` emits `<workspace>/.claude/skills_manifest.json`
listing skills the project requires. The DevContainer Feature install
script (`bootstrapper/claude-hive-feature/install.sh`) reads this manifest
on container create and reports the expected skill count. Full skill
materialization is performed by the hub on first container start.

## Skills & Agents

Claude Hive includes 8 custom skills and 4 custom agents in `.claude/`.

### Skills
| Skill | Purpose |
|---|---|
| `hive-orchestration` | Dispatch commands across containers, aggregate results |
| `devcontainer-provisioning` | Generate devcontainer configs from templates |
| `cross-repo-gitops` | Manage PRs and commits across repos |
| `ml-cuda-workflow` | PyTorch/Lightning/HuggingFace patterns for Blackwell GPU |
| `compbio-workflow` | Single-cell, NGS, protein modeling pipelines |
| `web-dev-workflow` | FastAPI + React full-stack patterns |
| `container-health` | Diagnose and fix container issues |
| `project-bootstrap` | Interactive project setup wizard |

### Agents
| Agent | Purpose |
|---|---|
| `hive-coordinator` | Top-level orchestrator across containers |
| `provisioner` | Generates new devcontainer environments |
| `gitops-reviewer` | Surfaces PRs needing attention, drafts reviews |
| `container-doctor` | Diagnoses unhealthy containers |

## Authentication

Claude Hive uses **Max plan subscription auth**, not API keys.

| Context | Auth Method |
|---|---|
| All devcontainers | Shared `claude-auth` volume (OAuth login) |
| GitHub operations | `GITHUB_TOKEN` in `.env` |
| GitHub Actions (@claude) | `ANTHROPIC_API_KEY` as GitHub repo secret only |

The entrypoint.sh actively guards against API key contamination. If `ANTHROPIC_API_KEY` is accidentally set in any container's environment, it is automatically unset with a warning.

### Usage at Scale

Max plan usage is shared across all Claude Code sessions. With 7+ containers:
- Use Opus for complex work, Haiku for routine tasks (`/model`)
- Run `/compact` at 50% context to reduce token consumption
- Limit concurrent active sessions to 2-3
- Enable extra usage on your Max plan if you consistently hit limits

## Development

### Running Tests

```bash
# Python tests (hub, hive-agent, bootstrapper, gitops)
python -m pytest hive-agent/tests/ bootstrapper/tests/ hub/tests/ gitops/tests/ -v

# Dashboard tests
cd dashboard && npx vitest run
```

### Project Structure

```
claude-hive/
├── CLAUDE.md                         # Project instructions for Claude Code
├── README.md                         # This file
├── troubleshoot.md                   # Symptom → Cause → Fix entries
├── .env.example                      # Environment variable template
├── hub/                              # FastAPI hub server
│   ├── main.py                       # App + CLI entrypoint
│   ├── routers/                      # REST + WebSocket endpoints
│   ├── services/                     # Registry, devcontainer mgr, relay, monitors
│   ├── models/                       # Pydantic schemas
│   └── tests/
├── dashboard/                        # React + Vite + Tailwind frontend
│   └── src/
│       ├── components/               # UI components
│       ├── hooks/                    # WebSocket hook
│       └── lib/                      # API client, types
├── hive-agent/                       # Worker-side client (pip-installable)
│   └── hive_agent/                   # Heartbeat, command listener, CLI
├── bootstrapper/                     # Provisioning system
│   ├── templates/                    # devcontainer.json + Dockerfile + CLAUDE.md per type
│   ├── skill_registries/             # Curated skill lists per project type
│   ├── hooks/                        # Default hook configs per type
│   ├── claude-hive-feature/          # DevContainer Feature
│   └── provision.py                  # Provisioning orchestrator
├── gitops/                           # Git operations module
│   ├── repo_scanner.py               # Parallel repo status scanning
│   ├── pr_manager.py                 # PR lifecycle across repos
│   └── commit_manager.py             # Stage, commit, push, batch
└── .claude/
    ├── skills/                       # 8 custom skills
    └── agents/                       # 4 custom agents
```

## Troubleshooting

### Hub won't start
```bash
# Check prerequisites
which docker git node gh devcontainer

# Check if port is in use
lsof -i :8420
```

### Container unreachable
```bash
# Check if container is running
docker ps | grep <container-name>

# Check hive-agent inside container
docker exec <container-id> curl http://127.0.0.1:9100/health

# Restart hive-agent
docker exec <container-id> hive-agent start --daemon
```

### Auth issues
```bash
# Check auth status across all containers
curl http://127.0.0.1:8420/api/auth/status | python -m json.tool

# Verify no API key contamination
docker exec <container-id> bash -c 'echo $ANTHROPIC_API_KEY'
# Should print empty line

# Re-login if needed
docker exec -it <container-id> claude
```

### GPU not available in ML container
```bash
# Verify nvidia-container-toolkit
nvidia-smi
docker run --rm --gpus all nvidia/cuda:13.2.0-base-ubuntu24.04 nvidia-smi

# Check devcontainer.json has runArgs
grep gpus .devcontainer/devcontainer.json
```

## License

MIT
