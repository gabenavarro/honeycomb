"""Claude Hive Hub — FastAPI application and CLI entrypoint."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from fastapi import Request as FARequest

from hub.models.schemas import EventPayload, HeartbeatPayload, WSFrame
from hub.routers import commands, containers, discover, gitops, pty, ws
from hub.services.claude_relay import ClaudeRelay
from hub.services.devcontainer_manager import DevContainerManager
from hub.services.registry import Registry
from hub.services.autodiscovery import discover_containers
from hub.services.health_checker import HealthChecker
from hub.services.pty_session import PtyRegistry
from hub.services.resource_monitor import ResourceMonitor

logger = logging.getLogger("hub")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle for the hub."""
    # Startup
    db_path = os.environ.get("HIVE_DB_PATH", str(Path.home() / ".claude-hive" / "registry.db"))
    registry = Registry(db_path=db_path)
    await registry.open()

    devcontainer_mgr = DevContainerManager()
    claude_relay = ClaudeRelay(devcontainer_mgr)
    resource_monitor = ResourceMonitor(poll_interval=5.0)
    health_checker = HealthChecker(registry, check_interval=10.0)
    pty_registry = PtyRegistry()

    app.state.registry = registry
    app.state.devcontainer_mgr = devcontainer_mgr
    app.state.claude_relay = claude_relay
    app.state.resource_monitor = resource_monitor
    app.state.health_checker = health_checker
    app.state.pty_registry = pty_registry

    # Start background services
    await resource_monitor.start()
    await health_checker.start()

    # Auto-discover running containers with hive-agent
    try:
        discovered = await discover_containers(registry)
        if discovered > 0:
            logger.info("Auto-discovered %d containers on startup", discovered)
    except Exception as exc:
        logger.warning("Auto-discovery failed (non-fatal): %s", exc)

    logger.info("Claude Hive Hub started")
    yield

    # Shutdown
    await pty_registry.close_all()
    await health_checker.stop()
    await resource_monitor.stop()
    await claude_relay.close()
    await registry.close()
    logger.info("Claude Hive Hub stopped")


app = FastAPI(
    title="Claude Hive Hub",
    description="Centralized orchestrator for devcontainer-based Claude Code environments",
    version="0.1.0",
    lifespan=lifespan,
)

# Local-only — no auth needed
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount routers
app.include_router(containers.router)
app.include_router(commands.router)
app.include_router(discover.router)
app.include_router(gitops.router)
app.include_router(pty.router)
app.include_router(ws.router)


# --- Heartbeat & Event endpoints (called by hive-agent in containers) ---

@app.post("/api/heartbeat")
async def receive_heartbeat(request: FARequest, payload: HeartbeatPayload) -> dict:
    """Receive a heartbeat from a hive-agent inside a container."""
    registry: Registry = request.app.state.registry
    health_checker: HealthChecker = request.app.state.health_checker

    # Record heartbeat for timeout tracking
    await health_checker.record_heartbeat(payload.container_id)

    record = await registry.get_by_container_id(payload.container_id)
    if record:
        await registry.update(
            record.id,
            agent_status=payload.status,
            agent_port=payload.agent_port,
        )

    # Broadcast to WebSocket subscribers
    await ws.manager.broadcast(WSFrame(
        channel=payload.container_id,
        event="heartbeat",
        data=payload.model_dump(),
    ))

    return {"ok": True}


@app.post("/api/events")
async def receive_event(request: FARequest, payload: EventPayload) -> dict:
    """Receive an event from a hive-agent inside a container.

    Events with event_type == "command_output" are fanned out on a dedicated
    channel (cmd:{command_id}) so dashboard terminals can subscribe to a
    specific command without filtering on the container firehose.

    Expected data shape for command_output:
        {command_id, stream ("stdout"|"stderr"), text, ts (iso8601)}
    """
    # Keep logging quiet on command_output (hot path), verbose for everything else.
    if payload.event_type != "command_output":
        logger.info("Event from %s: %s", payload.container_id, payload.event_type)

    # Always broadcast on the container channel.
    await ws.manager.broadcast(WSFrame(
        channel=payload.container_id,
        event=payload.event_type,
        data=payload.data,
    ))

    # Additionally fan out command_output on the per-command channel.
    if payload.event_type == "command_output":
        command_id = (payload.data or {}).get("command_id")
        if command_id:
            await ws.manager.broadcast(WSFrame(
                channel=f"cmd:{command_id}",
                event="command_output",
                data=payload.data,
            ))

    return {"ok": True}


@app.get("/api/health")
async def health(request: FARequest) -> dict:
    """Hub health check."""
    registry: Registry = request.app.state.registry
    containers_list = await registry.list_all()
    return {
        "status": "ok",
        "version": "0.1.0",
        "registered_containers": len(containers_list),
    }


AUTH_PROBE_TIMEOUT_SECONDS = 5
AUTH_PROBE_TOTAL_TIMEOUT_SECONDS = 20


async def _probe_container_auth(devcontainer_mgr, record) -> dict:
    """Probe a single container's auth state. Each probe is bounded; overall
    call completes under (2 * probe timeout) seconds even if both hang.
    """
    async def _api_key_probe() -> bool:
        rc, stdout, _ = await devcontainer_mgr._run_cmd(
            ["docker", "exec", record.container_id,
             "bash", "-c", 'echo $ANTHROPIC_API_KEY'],
            timeout=AUTH_PROBE_TIMEOUT_SECONDS,
        )
        return bool(stdout.strip())

    async def _creds_probe() -> bool:
        rc2, stdout2, _ = await devcontainer_mgr._run_cmd(
            ["docker", "exec", record.container_id,
             "bash", "-c",
             'test -f /root/.claude/credentials.json -o -f /root/.claude/.credentials.json && echo yes || echo no'],
            timeout=AUTH_PROBE_TIMEOUT_SECONDS,
        )
        return stdout2.strip() == "yes"

    try:
        has_api_key = await _api_key_probe()
    except Exception:
        has_api_key = False
    try:
        has_credentials = await _creds_probe()
    except Exception:
        has_credentials = False

    if has_api_key:
        auth = "api_key_warning"
    elif has_credentials:
        auth = "subscription_login"
    else:
        auth = "not_logged_in"

    return {
        "container_id": record.container_id,
        "project_name": record.project_name,
        "auth": auth,
    }


@app.get("/api/auth/status")
async def auth_status(request: FARequest) -> dict:
    """Check auth status across all running containers.

    Probes run in parallel and the whole endpoint is bounded by
    AUTH_PROBE_TOTAL_TIMEOUT_SECONDS so a single hung container cannot
    block the dashboard.
    """
    registry: Registry = request.app.state.registry
    devcontainer_mgr = request.app.state.devcontainer_mgr
    records = await registry.list_all()

    statuses: list[dict] = []
    probes: list[tuple[object, asyncio.Task]] = []

    for record in records:
        if record.container_status.value != "running" or not record.container_id:
            statuses.append({
                "container_id": record.container_id,
                "project_name": record.project_name,
                "auth": "not_running",
            })
            continue
        probes.append((record, asyncio.create_task(
            _probe_container_auth(devcontainer_mgr, record)
        )))

    if probes:
        try:
            await asyncio.wait_for(
                asyncio.gather(*(t for _, t in probes), return_exceptions=True),
                timeout=AUTH_PROBE_TOTAL_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "auth_status: aggregate probe timeout after %ds — returning partial results",
                AUTH_PROBE_TOTAL_TIMEOUT_SECONDS,
            )

        for record, task in probes:
            if task.done() and not task.cancelled():
                exc = task.exception()
                if exc is None:
                    statuses.append(task.result())
                    continue
            else:
                task.cancel()
            statuses.append({
                "container_id": record.container_id,
                "project_name": record.project_name,
                "auth": "probe_timeout",
            })

    return {"containers": statuses}


def cli() -> None:
    """CLI entrypoint: `hive`."""
    import uvicorn

    host = os.environ.get("HIVE_HOST", "127.0.0.1")
    port = int(os.environ.get("HIVE_PORT", "8420"))

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    # Check prerequisites
    _check_prerequisites()

    logger.info("Starting Claude Hive Hub on %s:%d", host, port)
    logger.info("Dashboard: http://%s:%d", host, port)

    # Try to open dashboard in browser (silently ignore on headless/WSL)
    try:
        import subprocess
        subprocess.Popen(
            ["python3", "-c", f"import webbrowser; webbrowser.open('http://{host}:{port}')"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass

    uvicorn.run(app, host=host, port=port)


def _check_prerequisites() -> None:
    """Verify required tools are available."""
    import shutil

    missing = []
    for tool in ["docker", "git"]:
        if not shutil.which(tool):
            missing.append(tool)

    if not shutil.which("devcontainer"):
        logger.warning(
            "devcontainer CLI not found. Install with: npm install -g @devcontainers/cli"
        )

    if not os.environ.get("GITHUB_TOKEN"):
        logger.warning("GITHUB_TOKEN not set — GitHub operations will fail")

    if os.environ.get("ANTHROPIC_API_KEY"):
        logger.warning(
            "ANTHROPIC_API_KEY is set on the host. This is NOT passed to containers. "
            "Claude Hive uses Max plan subscription auth via shared claude-auth volume. "
            "If you need API key auth for GitHub Actions, store it as a GitHub repo secret only."
        )

    # Check for shared auth volume
    auth_dir = Path.home() / ".claude"
    has_creds = auth_dir.exists() and (
        (auth_dir / "credentials.json").exists()
        or (auth_dir / ".credentials.json").exists()
    )
    if has_creds:
        logger.info("Claude subscription credentials found on host")
    else:
        logger.info(
            "No Claude subscription credentials found on host. "
            "Login via: docker compose run --rm <container> claude"
        )

    if missing:
        logger.error("Required tools not found: %s", ", ".join(missing))
        sys.exit(1)


if __name__ == "__main__":
    cli()
