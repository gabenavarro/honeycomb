"""Prometheus metrics for the Claude Hive hub.

The metric set is intentionally small and focused on the signals that
matter at the hub's scale (~7+ containers, one operator):

- ``hive_containers``        gauge, labelled by status
- ``hive_commands_total``    counter, labelled by relay_path
- ``hive_pty_sessions``      gauge, current active PTY sessions
- ``hive_ws_clients``        gauge, current dashboard WebSocket clients

Metrics live in a single ``CollectorRegistry`` owned by this module so
tests can instantiate fresh registries without pulling in the process-
global default (which pytest test isolation fights with).
"""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge, generate_latest
from prometheus_client.exposition import CONTENT_TYPE_LATEST

# One shared registry for the hub. Sub-modules import the concrete
# Counter/Gauge objects below rather than interacting with the registry
# directly — that keeps instrumentation sites concise.
REGISTRY = CollectorRegistry()


containers_by_status = Gauge(
    "hive_containers",
    "Registered containers by status (running, stopped, starting, error, unknown).",
    ["status"],
    registry=REGISTRY,
)

commands_total = Counter(
    "hive_commands_total",
    "One-shot commands relayed, labelled by which path served them.",
    ["relay_path"],
    registry=REGISTRY,
)

pty_sessions = Gauge(
    "hive_pty_sessions",
    "Active persistent-PTY sessions currently held open by the hub.",
    registry=REGISTRY,
)

ws_clients = Gauge(
    "hive_ws_clients",
    "Dashboard WebSocket clients currently connected to the multiplex /ws.",
    registry=REGISTRY,
)


def render() -> tuple[bytes, str]:
    """Render the current metrics in the Prometheus text exposition format.

    Returns ``(body, content_type)`` so the caller can set the response
    header correctly without importing ``prometheus_client`` itself.
    """
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST


def set_container_status_counts(counts: dict[str, int]) -> None:
    """Atomically replace the ``hive_containers{status=…}`` gauge values.

    Any status present in the previous call but absent from ``counts``
    is zeroed out so stale labels don't linger. Callers typically invoke
    this after a registry scan.
    """
    known = {"running", "stopped", "starting", "error", "unknown"}
    for status in known:
        containers_by_status.labels(status=status).set(counts.get(status, 0))
