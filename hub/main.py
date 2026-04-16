"""Claude Hive Hub — FastAPI application and CLI entrypoint."""

from __future__ import annotations

import asyncio
import contextlib
import os
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi import Request as FARequest
from fastapi.middleware.cors import CORSMiddleware

from hub.config import HiveSettings, get_settings
from hub.logging_setup import (
    bind_container_id,
    bind_request_id,
    configure_log_broadcast,
    configure_logging,
    get_logger,
)
from hub.models.schemas import EventPayload, HeartbeatPayload, WSFrame
from hub.routers import commands, containers, discover, gitops, pty, ws
from hub.services import metrics
from hub.services.autodiscovery import discover_containers
from hub.services.claude_relay import ClaudeRelay
from hub.services.devcontainer_manager import DevContainerManager
from hub.services.health_checker import HealthChecker
from hub.services.pty_session import PtyRegistry
from hub.services.registry import Registry
from hub.services.resource_monitor import ResourceMonitor

logger = get_logger("hub")


# Bounded queue that buffers structured log events on their way to the
# "logs:hub" WebSocket channel. 1024 entries is generous for a local hub;
# if the dashboard falls behind we prefer to drop oldest rather than
# block any log call site.
_LOG_QUEUE_MAX = 1024


async def _refresh_container_metrics(registry: Registry) -> None:
    """Snapshot container counts by status into the Prometheus gauge."""
    records = await registry.list_all()
    counts: dict[str, int] = {}
    for r in records:
        counts[r.container_status.value] = counts.get(r.container_status.value, 0) + 1
    metrics.set_container_status_counts(counts)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle for the hub."""
    settings = get_settings()
    configure_logging(settings)

    logger.info(
        "hub_starting",
        host=settings.host,
        port=settings.port,
        db_path=str(settings.db_path),
        log_level=settings.log_level,
        log_format=settings.log_format,
        metrics_enabled=settings.metrics_enabled,
        auth_enabled=bool(settings.auth_token),
    )

    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    registry = Registry(db_path=str(settings.db_path))
    await registry.open()

    devcontainer_mgr = DevContainerManager()
    claude_relay = ClaudeRelay(devcontainer_mgr)
    resource_monitor = ResourceMonitor(poll_interval=5.0)
    health_checker = HealthChecker(registry, check_interval=10.0)
    pty_registry = PtyRegistry()

    app.state.settings = settings
    app.state.registry = registry
    app.state.devcontainer_mgr = devcontainer_mgr
    app.state.claude_relay = claude_relay
    app.state.resource_monitor = resource_monitor
    app.state.health_checker = health_checker
    app.state.pty_registry = pty_registry

    # ── logs:hub WebSocket fan-out ──────────────────────────────────
    # The sink is called synchronously from every log call; to keep it
    # fast and thread-safe, it only enqueues. A drainer coroutine on the
    # main event loop consumes the queue and broadcasts on the "logs:hub"
    # channel. Full queue -> drop oldest (so a slow dashboard client
    # cannot cause back-pressure into the logger itself).
    main_loop = asyncio.get_running_loop()
    log_queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=_LOG_QUEUE_MAX)

    def _enqueue_log(event: dict) -> None:
        if log_queue.full():
            # Drop the oldest to make room. Safe on the loop thread only.
            try:
                log_queue.get_nowait()
            except asyncio.QueueEmpty:
                return
        with contextlib.suppress(asyncio.QueueFull):
            log_queue.put_nowait(event)

    def _sink(event: dict) -> None:
        if main_loop.is_closed():
            return
        # RuntimeError here means the loop has already shut down.
        with contextlib.suppress(RuntimeError):
            main_loop.call_soon_threadsafe(_enqueue_log, event)

    async def _drainer() -> None:
        while True:
            event = await log_queue.get()
            # Broadcast problems must never kill the drainer.
            with contextlib.suppress(Exception):
                await ws.manager.broadcast(WSFrame(channel="logs:hub", event="log", data=event))

    configure_log_broadcast(_sink)
    drainer_task = asyncio.create_task(_drainer(), name="hub-log-drainer")
    app.state.log_drainer_task = drainer_task

    # Start background services
    await resource_monitor.start()
    await health_checker.start()

    # Prime metrics gauges
    await _refresh_container_metrics(registry)

    # Auto-discover running containers with hive-agent
    try:
        discovered = await discover_containers(registry)
        if discovered > 0:
            logger.info("hub_autodiscovered", count=discovered)
        await _refresh_container_metrics(registry)
    except Exception as exc:
        logger.warning("hub_autodiscovery_failed", error=str(exc))

    logger.info("hub_started")
    yield

    # ── Shutdown ───────────────────────────────────────────────────
    configure_log_broadcast(None)
    drainer_task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await drainer_task

    await pty_registry.close_all()
    await health_checker.stop()
    await resource_monitor.stop()
    await claude_relay.close()
    await registry.close()
    logger.info("hub_stopped")


app = FastAPI(
    title="Claude Hive Hub",
    description="Centralized orchestrator for devcontainer-based Claude Code environments",
    version="0.1.0",
    lifespan=lifespan,
)

# Local-only by default. M3 replaces the wildcard with an allowlist and
# adds bearer-token auth, at which point 0.0.0.0 deployment becomes safe.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_id_middleware(request: FARequest, call_next):
    """Bind a short request-id into the logging contextvar for every request.

    Uses the caller's ``X-Request-ID`` header if present (useful behind a
    reverse proxy), otherwise mints one. The id is echoed back in the
    response header so operators can correlate logs with a browser-side
    network trace.
    """
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    bind_request_id(rid)
    try:
        response = await call_next(request)
    finally:
        bind_request_id(None)
        bind_container_id(None)
    response.headers["X-Request-ID"] = rid
    return response


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

    bind_container_id(payload.container_id)
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
    await ws.manager.broadcast(
        WSFrame(
            channel=payload.container_id,
            event="heartbeat",
            data=payload.model_dump(),
        )
    )

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
    bind_container_id(payload.container_id)
    # Keep logging quiet on command_output (hot path), verbose for everything else.
    if payload.event_type != "command_output":
        logger.info(
            "hub_agent_event",
            container_id=payload.container_id,
            event_type=payload.event_type,
        )

    # Always broadcast on the container channel.
    await ws.manager.broadcast(
        WSFrame(
            channel=payload.container_id,
            event=payload.event_type,
            data=payload.data,
        )
    )

    # Additionally fan out command_output on the per-command channel.
    if payload.event_type == "command_output":
        command_id = (payload.data or {}).get("command_id")
        if command_id:
            await ws.manager.broadcast(
                WSFrame(
                    channel=f"cmd:{command_id}",
                    event="command_output",
                    data=payload.data,
                )
            )

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


@app.get("/metrics")
async def metrics_endpoint(request: FARequest) -> Response:
    """Prometheus scrape endpoint.

    Returns 404 when HIVE_METRICS_ENABLED=false so operators who don't
    want metrics can hide the route entirely instead of returning an
    empty document.
    """
    settings: HiveSettings = request.app.state.settings
    if not settings.metrics_enabled:
        return Response(status_code=404)
    registry: Registry = request.app.state.registry
    # Refresh the containers gauge on every scrape. Cheap — one SQLite
    # read — and keeps the metric correct even if a write path forgot
    # to call the refresh helper.
    await _refresh_container_metrics(registry)
    body, content_type = metrics.render()
    return Response(content=body, media_type=content_type)


AUTH_PROBE_TIMEOUT_SECONDS = 5
AUTH_PROBE_TOTAL_TIMEOUT_SECONDS = 20


async def _probe_container_auth(devcontainer_mgr, record) -> dict:
    """Probe a single container's auth state. Each probe is bounded; overall
    call completes under (2 * probe timeout) seconds even if both hang.
    """

    async def _api_key_probe() -> bool:
        _rc, stdout, _ = await devcontainer_mgr._run_cmd(
            ["docker", "exec", record.container_id, "bash", "-c", "echo $ANTHROPIC_API_KEY"],
            timeout=AUTH_PROBE_TIMEOUT_SECONDS,
        )
        return bool(stdout.strip())

    async def _creds_probe() -> bool:
        _rc2, stdout2, _ = await devcontainer_mgr._run_cmd(
            [
                "docker",
                "exec",
                record.container_id,
                "bash",
                "-c",
                "test -f /root/.claude/credentials.json -o -f /root/.claude/.credentials.json && echo yes || echo no",
            ],
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
            statuses.append(
                {
                    "container_id": record.container_id,
                    "project_name": record.project_name,
                    "auth": "not_running",
                }
            )
            continue
        probes.append(
            (record, asyncio.create_task(_probe_container_auth(devcontainer_mgr, record)))
        )

    if probes:
        try:
            await asyncio.wait_for(
                asyncio.gather(*(t for _, t in probes), return_exceptions=True),
                timeout=AUTH_PROBE_TOTAL_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            logger.warning(
                "auth_status_aggregate_timeout",
                timeout_s=AUTH_PROBE_TOTAL_TIMEOUT_SECONDS,
            )

        for record, task in probes:
            if task.done() and not task.cancelled():
                exc = task.exception()
                if exc is None:
                    statuses.append(task.result())
                    continue
            else:
                task.cancel()
            statuses.append(
                {
                    "container_id": record.container_id,
                    "project_name": record.project_name,
                    "auth": "probe_timeout",
                }
            )

    return {"containers": statuses}


def cli() -> None:
    """CLI entrypoint: `hive`."""
    import uvicorn

    settings = get_settings()
    # Configure logging before anything else so prerequisite checks and
    # any uvicorn bootstrap messages flow through the structured pipeline.
    configure_logging(settings)

    # Check prerequisites
    _check_prerequisites()

    logger.info("hub_cli_starting", host=settings.host, port=settings.port)

    # Try to open dashboard in browser (silently ignore on headless/WSL)
    try:
        import subprocess

        subprocess.Popen(
            [
                "python3",
                "-c",
                f"import webbrowser; webbrowser.open('http://{settings.host}:{settings.port}')",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass

    # Uvicorn's own logs have already been wired up by configure_logging.
    # Disable its default log_config so it doesn't overwrite our handlers.
    uvicorn.run(app, host=settings.host, port=settings.port, log_config=None)


def _check_prerequisites() -> None:
    """Verify required tools are available."""
    import shutil

    missing = []
    for tool in ["docker", "git"]:
        if not shutil.which(tool):
            missing.append(tool)

    if not shutil.which("devcontainer"):
        logger.warning("hub_prereq_missing", tool="devcontainer")

    if not os.environ.get("GITHUB_TOKEN"):
        logger.warning("hub_prereq_missing_env", variable="GITHUB_TOKEN")

    if os.environ.get("ANTHROPIC_API_KEY"):
        logger.warning(
            "hub_anthropic_api_key_on_host",
            hint=(
                "ANTHROPIC_API_KEY is set on the host. This is NOT passed to containers. "
                "Claude Hive uses Max plan subscription auth via shared claude-auth volume."
            ),
        )

    # Check for shared auth volume
    auth_dir = Path.home() / ".claude"
    has_creds = auth_dir.exists() and (
        (auth_dir / "credentials.json").exists() or (auth_dir / ".credentials.json").exists()
    )
    if has_creds:
        logger.info("hub_subscription_creds_present")
    else:
        logger.info(
            "hub_subscription_creds_absent",
            hint="login via: docker compose run --rm <container> claude",
        )

    if missing:
        logger.error("hub_prereq_missing_tools", tools=missing)
        sys.exit(1)


if __name__ == "__main__":
    cli()
