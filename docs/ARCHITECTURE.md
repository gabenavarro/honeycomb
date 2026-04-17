# Honeycomb Architecture

> Snapshot as of `v0.1.0`. Updated with every milestone merge; the
> subsection headers align with the milestones in the roadmap.

## 1. Block diagram

```
                         ┌───────────────────────────┐
                         │  Browser (React 19 SPA)    │
                         │  Vite dev or static build  │
                         │                            │
                         │  ┌─────────────────────┐   │
                         │  │   AuthGate (M3)     │   │
                         │  │   token prompt      │   │
                         │  └──────────┬──────────┘   │
                         │             ▼              │
                         │  ┌─────────────────────┐   │
                         │  │  ActivityBar rail   │   │ M10 adds SCM,
                         │  │  Containers / SCM / │   │ Problems,
                         │  │  Git Ops / Problems │   │ Keybindings
                         │  │  / Settings / etc.  │   │
                         │  └──────────┬──────────┘   │
                         │             ▼              │
                         │  ┌─────────────────────┐   │
                         │  │  Editor area        │   │ Split editor
                         │  │  (ContainerTabs +   │   │ via react-
                         │  │   xterm.js panes)   │   │ resizable-panels
                         │  └─────────────────────┘   │
                         └────────────┬──────────────┘
                                      │ HTTPS + WSS (Bearer token)
                                      ▼
     ┌────────────────────────────────────────────────────────────┐
     │                 Claude Hive Hub (FastAPI)                   │
     │                                                             │
     │  AuthMiddleware ─► request-id ─► CORS ─► routers            │
     │                                                             │
     │  ┌─────────────────┐  ┌──────────────┐  ┌───────────────┐   │
     │  │ REST routers    │  │ WS manager   │  │ ProblemLog    │   │
     │  │ containers,     │  │ channels:    │  │ (M10) ring    │   │
     │  │ commands,       │  │ containers,  │  │ buffer 256    │   │
     │  │ pty, discover,  │  │ problems,    │  └───────────────┘   │
     │  │ gitops, agent,  │  │ logs:hub,    │  ┌───────────────┐   │
     │  │ problems (M10), │  │ cmd:{id},    │  │ AgentRegistry │   │
     │  │ settings (M10), │  │ build:{…}    │  │ (M4 tunnel)   │   │
     │  │ keybindings,    │  └──────────────┘  └───────────────┘   │
     │  │ health, metrics │  ┌──────────────┐  ┌───────────────┐   │
     │  └─────────────────┘  │ PtyRegistry  │  │ ClaudeRelay   │   │
     │                       │ (/ws/pty/…)  │  │ 3-path relay  │   │
     │                       └──────────────┘  └───────────────┘   │
     │                                                             │
     │  Registry (M7 — SQLAlchemy async + Alembic, SQLite)          │
     │  HealthChecker, ResourceMonitor, LogDrainer                  │
     └────────────┬───────────────────────────────┬────────────────┘
                  │                               │
        devcontainer CLI / docker exec       WSS reverse tunnel
                  │                               ▲
                  ▼                               │
         ┌────────────────────┐        ┌──────────┴───────────┐
         │ VSCode Dev          │◄──────┤  hive-agent (worker) │
         │ Container (dev      │        │  - heartbeats         │
         │  stage, non-root    │        │  - cmd_exec runner    │
         │  app user)          │        │  - output fan-out     │
         │   ─────────────     │        └───────────────────────┘
         │  Claude Code CLI    │
         │  hive-agent pkg     │
         │  project tooling    │
         └─────────────────────┘
```

## 2. Key layers

### 2.1 Hub (`hub/`)

- **FastAPI + uvicorn**, `asyncio`-first.
- Middleware stack (outer → inner): CORS, request-id binding, bearer-token
  auth (`_LazyAuthMiddleware` reads `app.state.auth_token` on every
  request so tests can swap it without reinstantiating the app).
- Lifespan wires services: `Registry` (SQLAlchemy async + Alembic),
  `DevContainerManager`, `ResourceMonitor`, `HealthChecker` (M10 feeds
  `ProblemLog`), `PtyRegistry`, `AgentRegistry`, `ClaudeRelay`,
  `ProblemLog` (M10).
- Routers expose REST + WebSocket surface documented in
  [README.md](../README.md#hub-api-reference).
- Structured logging via `structlog` (M2). A subset of events fans out
  on the `logs:hub` WebSocket channel through a bounded queue + drainer
  task, so a slow dashboard cannot back-pressure the logger.
- `/metrics` exposes Prometheus counters/gauges when
  `metrics_enabled=true`.

### 2.2 Dashboard (`dashboard/`)

- **React 19 + Vite 8 + Tailwind v4 + TanStack Query v5**.
- Activities are persisted in localStorage via the typed `useLocalStorage`
  hook (M9). Split-editor state lives in the same store.
- xterm.js (WebGL addon with DOM fallback) owns the terminal renderer.
  Persistent PTY sessions reattach across reloads via `sessionStorage`
  labels.
- Runtime boundary validation: every REST response is passed through a
  `zod` schema that logs (but does not throw on) mismatches.
- A11y: Radix primitives for Dialog/Tabs/Toast/Tooltip (M8); `cmdk` for
  the command palette; global `:focus-visible` ring; `prefers-color-scheme`
  flips chrome colours.

### 2.3 Worker agent (`hive-agent/`)

- Installed as the first step of the `dev` stage in every devcontainer
  template.
- Since M4 the agent dials the hub over WebSocket
  (`wss://hub/api/agent/connect?token=…&container=…`) instead of
  binding an HTTP listener inside the container. The reverse tunnel
  carries heartbeats, command dispatch, and output.
- Pydantic-typed wire frames live in `hive_agent/protocol.py`; the hub
  imports the same module to guarantee byte-compatibility.

### 2.4 Bootstrapper (`bootstrapper/`)

- `provision.py` renders `devcontainer.json` + `CLAUDE.md` from a
  typed `TemplateContext` through a `SandboxedEnvironment` (M6).
- Templates use the `node:22-bookworm-slim` base with `uv` copied from
  the official `ghcr.io/astral-sh/uv` image; no `curl | sh` anywhere.
- The `claude-hive-feature` DevContainer Feature materialises skills +
  hooks + MCP configs into a container on first build.

### 2.5 Git Ops (`gitops/`)

- Async wrappers around `git` and `gh` CLIs; no shell interpolation
  (`asyncio.create_subprocess_exec` with argv lists).
- `scan_repos` runs across all registered workspace folders in
  parallel; `list_prs_across_repos` likewise.
- `/api/gitops/status/{workspace_folder}` (M10) returns
  staged/modified/untracked file lists for the Source Control view.

## 3. Sequence diagrams

### 3.1 Hub startup

```
hive CLI ── loads ─► HiveSettings (pydantic-settings)
                    │
                    ▼
                configure_logging(settings)           ← structlog + stdlib merge
                    │
                    ▼
                load_or_create_token(settings)        ← file → env → generated
                    │
                    ▼
                Registry.open()                       ← Alembic upgrade head
                    │
                    ▼
                start ResourceMonitor, HealthChecker
                    │
                    ▼
                ProblemLog.set_broadcast(ws manager)  ← M10
                    │
                    ▼
                autodiscovery.discover_containers()   ← scan running docker
                    │
                    ▼
                uvicorn.run(app, host, port)
```

### 3.2 Register a container via the Discover tab

```
Dashboard              Hub                         Docker / disk
    │                    │                                │
    │ GET /api/discover  │                                │
    ├───────────────────►│                                │
    │                    │ list running containers ──────►│
    │                    │ scan HIVE_DISCOVER_ROOTS ─────►│
    │   workspaces +     │                                │
    │   containers + ◄───┤                                │
    │   discover_roots   │                                │
    │                    │                                │
    │ POST /api/discover/register                         │
    ├───────────────────►│                                │
    │                    │ Registry.insert ──────────────►│
    │                    │ (optionally `devcontainer up`)─►│
    │                    │ broadcast "containers"         │
    │   ContainerRecord ◄┤                                │
    │                    │                                │
```

### 3.3 Run a one-shot command

```
Dashboard                      Hub                         Worker
    │                            │                            │
    │ POST /api/containers/{id}/commands                      │
    ├───────────────────────────►│                            │
    │                            │ try agent path (M4)        │
    │                            ├─────── cmd_exec ──────────►│
    │                            │                            ├── spawn subprocess
    │                            │                            │
    │  CommandResponse(relay_path="agent") ◄──── done ────────┤
    │                            │                            │
    │ SUBSCRIBE cmd:{id}         │                            │
    ├───────────────────────────►│                            │
    │  output frames             │                            │
    │    ◄───────────────────────┤ ◄── output frames ─────────┤
    │                            │                            │
```

Fallback order when the agent socket is unavailable:
`agent` → `devcontainer_exec` (requires `.devcontainer/devcontainer.json`)
→ `docker_exec` (`bash -lc`, retry `sh -c` for Alpine). All three
failing yields a 502 with the structured
`{agent_error, devcontainer_error, docker_error}` body and the
container record transitions to `error`.

### 3.4 Persistent PTY

```
Dashboard                    Hub                      docker
    │                         │                         │
    │ open /ws/pty/{record_id}│                         │
    ├────────────────────────►│                         │
    │                         │ lookup record           │
    │                         │ PtyRegistry.attach      │
    │                         │  - reuse existing       │
    │                         │  - or spawn docker exec │
    │                         │                         │
    │ text "sattached" or     │                         │
    │ text "sreattached:<s>"  │                         │
    │   ◄─────────────────────┤                         │
    │ text "sreplay:<N>"      │                         │
    │ binary <N-byte          │                         │
    │  scrollback>            │                         │
    │   ◄─────────────────────┤                         │
    │                         │                         │
    │ binary stdin ──────────►│ pty.write() ───────────►│
    │                         │                         │
    │   ◄──── binary stdout ──┤ ◄── pty.read() ─────────┤
    │                         │                         │
    │ (disconnect without `k`)│                         │
    │        ─ grace 5 min ─  │                         │
    │                         │                         │
```

Reattach is single-writer: a second client opening the same
`(record_id, label)` pair displaces the first. Labels persist in
`sessionStorage` so reloads land on the same PTY.

## 4. State machines

### Container record

```
unknown ─► starting ─► running
                │        │
                ▼        ▼
              error ◄─ stopped
                │        │
                ▼        ▼
              (starting, stopped, unknown allowed from error)
```

Same-state writes are dropped. Invalid transitions raise
`InvalidStateTransition` which the API surfaces as 409.

### Agent status

```
idle ◄─► busy         on heartbeat
  │       │
  ▼       ▼
unreachable   on missed heartbeats (health_checker)
  │
  └── on heartbeat resume: → idle + problem_log "info" entry
```

## 5. Files worth knowing

| Concern                  | Primary file                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Auth token resolution    | [hub/auth.py](../hub/auth.py)                                                                                                |
| Bearer middleware        | [hub/main.py `_LazyAuthMiddleware`](../hub/main.py)                                                                          |
| Three-path relay         | [hub/services/claude_relay.py](../hub/services/claude_relay.py)                                                              |
| Reverse tunnel transport | [hub/routers/agent.py](../hub/routers/agent.py), [hive-agent/hive_agent/ws_client.py](../hive-agent/hive_agent/ws_client.py) |
| Problem log              | [hub/services/problem_log.py](../hub/services/problem_log.py)                                                                |
| Settings overrides       | [hub/services/settings_overrides.py](../hub/services/settings_overrides.py)                                                  |
| Dashboard singleton WS   | [dashboard/src/hooks/useWebSocket.ts](../dashboard/src/hooks/useWebSocket.ts)                                                |
| Typed localStorage hook  | [dashboard/src/hooks/useLocalStorage.ts](../dashboard/src/hooks/useLocalStorage.ts)                                          |
| Split editor             | [dashboard/src/components/SplitEditor.tsx](../dashboard/src/components/SplitEditor.tsx)                                      |

## 6. Extensibility — explicit "no rewrite" stance (M19)

When the roadmap picked up user-requested features in M13–M19 (UI
polish, session caching, filesystem browse, Jupyter notebook viewer),
one question asked was whether a framework change would be warranted.
The answer is no:

- The stack (React 19 + Vite 8 + Tailwind v4 + xterm.js 6 + Radix +
  cmdk + TanStack Query v5) is current-gen and specifically chosen for
  multi-pane composability. Every feature added in M13–M19 is either a
  bug fix, an additive primitive, or a component drop — none required
  framework-level changes.
- The Jupyter viewer is the single largest "new capability" on the
  list. It lives in ~120 LOC (`NotebookViewer.tsx`) + 1 CSS import
  from `react-ipynb-renderer`. Execution support (kernel gateway,
  cell-run WebSocket) is a separate roadmap if demand sustains.
- Treating a component add as justification for a rewrite would be
  organizational debt, not technical progress.

The extensibility surface that matters going forward:

| Surface                           | Where to extend                                         |
| --------------------------------- | ------------------------------------------------------- |
| Sidebar activities                | Add to `ActivityBar` + new view under `src/components/` |
| File MIME dispatch                | `FileViewer.FileBody` — new extension / MIME branch     |
| Session kind (shell / claude / …) | `PtyPane` command + `useSession` kind                   |
| PTY transport alternatives        | `PtyRegistry.get_or_create` + `hub/routers/pty.py`      |
| New WS broadcast channel          | `hub/routers/ws.py` + client `useHiveWebSocket`         |

## 7. Further reading

- [README.md](../README.md) — quick start, API reference, contracts,
  keyboard shortcuts.
- [SECURITY.md](../SECURITY.md) — threat model + token rotation.
- [troubleshoot.md](../troubleshoot.md) — symptom → cause → fix.
- [CLAUDE.md](../CLAUDE.md) — agent-facing instructions.
