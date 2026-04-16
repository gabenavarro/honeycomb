"""CLI entrypoint for hive-agent.

Usage:
    hive-agent start              Start the agent (heartbeat + command listener)
    hive-agent start --port 9100  Start on a specific port
    hive-agent status             Check if the agent is running
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

import click
import uvicorn

from hive_agent.client import HiveClient
from hive_agent.command_listener import create_app


def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )


@click.group()
def main() -> None:
    """Claude Hive Agent — worker-side client for devcontainers."""


@main.command()
@click.option(
    "--port", default=None, type=int, help="Port for the command listener (default: 9100)"
)
@click.option("--hub-url", default=None, help="Hub URL (default: http://host.docker.internal:8420)")
@click.option("--container-id", default=None, help="Container identifier (default: hostname)")
@click.option("--heartbeat-interval", default=5.0, type=float, help="Heartbeat interval in seconds")
@click.option("--verbose", "-v", is_flag=True, help="Enable debug logging")
@click.option("--daemon", "-d", is_flag=True, help="Run in background (daemonize)")
def start(
    port: int | None,
    hub_url: str | None,
    container_id: str | None,
    heartbeat_interval: float,
    verbose: bool,
    daemon: bool,
) -> None:
    """Start the hive agent (heartbeat + command listener)."""
    if daemon:
        _daemonize()

    _setup_logging(verbose)
    agent_port = port or int(os.environ.get("HIVE_AGENT_PORT", "9100"))

    client = HiveClient(
        hub_url=hub_url,
        container_id=container_id,
        heartbeat_interval=heartbeat_interval,
        agent_port=agent_port,
    )

    app = create_app(client)

    async def _run() -> None:
        await client.start()
        config = uvicorn.Config(
            app,
            host="0.0.0.0",
            port=agent_port,
            log_level="debug" if verbose else "info",
        )
        server = uvicorn.Server(config)
        try:
            await server.serve()
        finally:
            await client.stop()

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        click.echo("Shutting down hive-agent...")


@main.command()
@click.option("--port", default=None, type=int, help="Agent port to check (default: 9100)")
def status(port: int | None) -> None:
    """Check if the hive agent is running locally."""
    import httpx

    agent_port = port or int(os.environ.get("HIVE_AGENT_PORT", "9100"))
    try:
        resp = httpx.get(f"http://127.0.0.1:{agent_port}/health", timeout=3.0)
        data = resp.json()
        click.echo(f"Agent is running: {data}")
    except httpx.ConnectError:
        click.echo(f"Agent is not running on port {agent_port}")
        sys.exit(1)


def _daemonize() -> None:
    """Fork into background (Unix only)."""
    if os.name != "posix":
        click.echo("Daemon mode is only supported on Unix systems", err=True)
        sys.exit(1)
    pid = os.fork()
    if pid > 0:
        click.echo(f"hive-agent started in background (pid={pid})")
        sys.exit(0)
    os.setsid()
    # Redirect stdio to /dev/null
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    os.close(devnull)


if __name__ == "__main__":
    main()
