"""Structured logging setup for the hub.

Goals:

1. **One pipeline for everything.** Third-party libraries log via stdlib
   ``logging``; our code uses ``structlog``. Both end up in the same
   processor chain so every log line has the same shape.
2. **Pretty in dev, JSON in prod.** ``HiveSettings.log_format`` picks
   between the two. ``auto`` chooses based on whether stderr is a TTY.
3. **Request-id and container-id binding.** A middleware assigns a
   request-id per HTTP call; anything logged during the handler gets
   that id attached without having to pass it explicitly.
4. **Optional fan-out to a WebSocket channel** (``logs:hub``) so the
   dashboard can tail the hub. The M3 auth work will gate this channel;
   for now anyone on the multiplex socket can subscribe to it.

Call ``configure_logging(settings)`` once from the lifespan start-up.
"""

from __future__ import annotations

import contextvars
import logging
import sys
from collections.abc import Callable
from typing import Any

import structlog
from structlog.types import EventDict

from hub.config import HiveSettings

_request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "hive_request_id", default=None
)
_container_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "hive_container_id", default=None
)


def bind_request_id(request_id: str | None) -> None:
    """Set the request-id context var for the current task/request."""
    _request_id_var.set(request_id)


def bind_container_id(container_id: str | None) -> None:
    """Set the container-id context var for code paths scoped to one container."""
    _container_id_var.set(container_id)


def _contextvar_processor(_logger: object, _name: str, event_dict: EventDict) -> EventDict:
    """Structlog processor that injects the ambient context vars into every event."""
    rid = _request_id_var.get()
    if rid is not None:
        event_dict.setdefault("request_id", rid)
    cid = _container_id_var.get()
    if cid is not None:
        event_dict.setdefault("container_id", cid)
    return event_dict


# Optional log sink — set by configure_log_broadcast() once the WebSocket
# manager exists during startup. Invoked synchronously on every log event,
# so it must be cheap and non-blocking.
_broadcast_sink: Callable[[dict[str, Any]], None] | None = None


def configure_log_broadcast(sink: Callable[[dict[str, Any]], None] | None) -> None:
    """Install or clear the hub-logs broadcast sink."""
    global _broadcast_sink
    _broadcast_sink = sink


def _broadcast_processor(_logger: object, _name: str, event_dict: EventDict) -> EventDict:
    """Structlog processor that fans each event out to the WS broadcaster, if any."""
    sink = _broadcast_sink
    if sink is not None:
        try:
            # Copy so downstream renderers can mutate without racing.
            sink(dict(event_dict))
        except Exception:
            # A broken sink must never break logging. Print to stderr so the
            # operator at least sees the failure; don't re-enter the logger.
            sys.stderr.write("[hive-log-sink error]\n")
    return event_dict


def _pick_renderer(log_format: str) -> structlog.types.Processor:
    if log_format == "json":
        return structlog.processors.JSONRenderer()
    if log_format == "pretty":
        return structlog.dev.ConsoleRenderer(colors=sys.stderr.isatty())
    # auto
    if sys.stderr.isatty():
        return structlog.dev.ConsoleRenderer(colors=True)
    return structlog.processors.JSONRenderer()


def configure_logging(settings: HiveSettings) -> None:
    """Wire stdlib + structlog into a single pipeline.

    Safe to call multiple times; each call fully replaces the previous
    configuration. The hub calls this once during lifespan start-up.
    """
    level = getattr(logging, settings.log_level)
    renderer = _pick_renderer(settings.log_format)

    # Shared pre-chain: processors that run for both stdlib and structlog events.
    # They must not emit — just enrich the event dict.
    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        _contextvar_processor,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    # Stdlib pipeline: events produced by third-party libraries (uvicorn,
    # httpx, docker, sqlalchemy in future milestones) enter here. We wrap
    # them in structlog.stdlib.ProcessorFormatter so they get the same
    # enrichment + rendering as our own structlog events.
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared_processors,
        processors=[
            _broadcast_processor,
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            renderer,
        ],
    )

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    # Replace existing handlers so reconfiguration is idempotent.
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(handler)
    root.setLevel(level)

    # Quieten chatty libraries. Raise these explicitly if operators hit
    # something they need to debug.
    logging.getLogger("watchfiles").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    # Structlog pipeline: hub code that opts in via `structlog.get_logger()`.
    # Terminates at `wrap_for_formatter`, which hands the rendered dict
    # off to the stdlib handler we just installed — so the broadcast sink
    # and renderer run exactly once.
    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """Return a structlog-bound logger. Prefer this over ``logging.getLogger``
    in new code — the output is the same, but the call site gets to attach
    structured fields without string-formatting."""
    return structlog.get_logger(name) if name else structlog.get_logger()


def update_log_level(level_name: str) -> None:
    """Re-bind root logger + structlog filtering to ``level_name``.

    Used by the M10 settings PATCH endpoint so operators can change the
    verbosity at runtime without restarting the hub. The renderer and
    handlers stay in place — only the level cut-off moves.
    """
    level = getattr(logging, level_name)
    logging.getLogger().setLevel(level)
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(level),
        cache_logger_on_first_use=True,
    )
