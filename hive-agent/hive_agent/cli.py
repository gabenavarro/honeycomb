"""CLI entrypoint for hive-agent.

Usage::

    hive-agent start              Start the agent (WebSocket tunnel to the hub)
    hive-agent start --verbose    Debug logging
    hive-agent status             Report whether an agent process looks alive
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

import click

from hive_agent.ws_client import HiveAgentWS


def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )


@click.group()
def main() -> None:
    """Claude Hive Agent — worker-side WebSocket client for devcontainers."""


@main.command()
@click.option(
    "--hub-url",
    default=None,
    help="Hub URL (default: $HIVE_HUB_URL or http://host.docker.internal:8420).",
)
@click.option(
    "--container-id",
    default=None,
    help="Container identifier (default: $HIVE_CONTAINER_ID or hostname).",
)
@click.option(
    "--heartbeat-interval",
    default=5.0,
    type=float,
    help="Heartbeat interval in seconds.",
)
@click.option("--verbose", "-v", is_flag=True, help="Enable debug logging")
@click.option("--daemon", "-d", is_flag=True, help="Run in background (daemonize)")
def start(
    hub_url: str | None,
    container_id: str | None,
    heartbeat_interval: float,
    verbose: bool,
    daemon: bool,
) -> None:
    """Open a WebSocket tunnel to the hub and serve commands."""
    if daemon:
        _daemonize()

    _setup_logging(verbose)

    client = HiveAgentWS(
        hub_url=hub_url,
        container_id=container_id,
        heartbeat_interval=heartbeat_interval,
    )

    async def _run() -> None:
        await client.start()
        try:
            # The run loop lives on client._run_task; park here so the
            # CLI process tracks its lifecycle until SIGINT.
            while True:
                await asyncio.sleep(3600)
        finally:
            await client.stop()

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        click.echo("Shutting down hive-agent...")


@main.command()
def status() -> None:
    """Best-effort check for a running hive-agent process on the box.

    Post-M4 the agent is a WebSocket client with no local listener, so
    this command simply reports whether a process is running. Useful for
    the hub to decide if it needs to spawn the agent in a container.
    """
    try:
        import subprocess

        out = subprocess.run(
            ["pgrep", "-f", "hive-agent"],
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        click.echo("pgrep not available; cannot determine hive-agent status.")
        sys.exit(2)

    pids = [line for line in out.stdout.splitlines() if line.strip()]
    own_pid = str(os.getpid())
    pids = [p for p in pids if p != own_pid]
    if pids:
        click.echo(f"hive-agent looks alive (pid(s): {', '.join(pids)})")
    else:
        click.echo("hive-agent is not running")
        sys.exit(1)


def _daemonize() -> None:
    """Fork into the background (Unix only)."""
    if os.name != "posix":
        click.echo("Daemon mode is only supported on Unix systems", err=True)
        sys.exit(1)
    pid = os.fork()
    if pid > 0:
        click.echo(f"hive-agent started in background (pid={pid})")
        sys.exit(0)
    os.setsid()
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    os.close(devnull)


if __name__ == "__main__":
    main()
