"""Bearer-token authentication for the Claude Hive hub (M3).

Every HTTP and WebSocket endpoint is gated by a single bearer token. The
token has three possible sources, checked in this order:

1. ``HIVE_AUTH_TOKEN`` environment variable (via :class:`HiveSettings`).
   Use this in tests, CI, and multi-hub deployments where the token
   needs to come from a secrets manager.
2. ``~/.config/honeycomb/token`` on disk (mode ``0600``). This is the
   default for local, single-operator use — the hub creates the file on
   first start and reuses it on every subsequent run.
3. Auto-generated on first start, written to the file above, and printed
   once to stdout with clear instructions. The dashboard prompts for
   this value the first time it loads.

The comparison always uses :func:`secrets.compare_digest` so the
implementation is timing-safe regardless of token length.

We deliberately *always* require a token. There is no ``auth_disabled``
mode. The historical "loopback-only, no auth" posture made it too easy
to leak the hub by flipping ``HIVE_HOST=0.0.0.0`` in a shell. Now even
loopback demands the token on every request; the only thing that
changes for local dev is that the token is generated transparently and
persisted to the operator's home directory.

Health check (``/api/health``), OpenAPI schema, and Swagger UI paths
are the only HTTP routes exempt from the middleware — the hub needs a
reachable liveness probe for external monitoring, and the OpenAPI
document is useful for development tooling. Everything else, including
``/metrics``, requires the token.

WebSocket endpoints (``/ws`` and ``/ws/pty/{id}``) accept the token as
a ``?token=…`` query parameter at connect time. Browsers cannot attach
custom headers to the WebSocket upgrade request, so the query param is
the only broadly-workable handshake mechanism.
"""

from __future__ import annotations

import contextlib
import os
import secrets
import stat
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import WebSocket, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from hub.config import HiveSettings


# Paths served without authentication. Minimal on purpose; anything added
# here needs a written justification in the PR that adds it.
_UNAUTH_PATHS: frozenset[str] = frozenset(
    {
        "/api/health",
        "/openapi.json",
        "/docs",
        "/docs/oauth2-redirect",
        "/redoc",
    }
)


def _token_file_path() -> Path:
    """Canonical on-disk location for the generated token.

    Respects ``XDG_CONFIG_HOME`` when set; otherwise uses
    ``~/.config/honeycomb/token`` in line with the XDG Base Directory
    spec and the pattern we documented in the plan.
    """
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base) if base else Path.home() / ".config"
    return root / "honeycomb" / "token"


def _generate_token() -> str:
    """Return a 256-bit URL-safe random token (~43 characters)."""
    return secrets.token_urlsafe(32)


def load_or_create_token(settings: HiveSettings) -> tuple[str, str]:
    """Return ``(token, source)`` where ``source`` is ``env``, ``file``, or ``generated``.

    This function has side effects on the ``generated`` path: it creates
    the parent directory, writes the token file with mode ``0600``, and
    prints a prominent notice to stdout. Callers should invoke it once
    at start-up and stash the result on ``app.state``.
    """
    # 1. Environment wins — highest priority so CI / containers stay
    #    deterministic.
    if settings.auth_token:
        return settings.auth_token, "env"

    path = _token_file_path()

    # 2. On-disk token from a previous start.
    if path.exists():
        try:
            token = path.read_text(encoding="utf-8").strip()
        except OSError:
            token = ""
        if token:
            # Repair permissions if an editor or rsync widened them.
            try:
                mode = stat.S_IMODE(path.stat().st_mode)
                if mode & 0o077:
                    path.chmod(0o600)
            except OSError:
                pass
            return token, "file"

    # 3. First start — generate, persist, announce.
    token = _generate_token()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write then chmod — write() via Path can land with the umask-masked
    # default, which on most systems is 0o644. Chmod to 0600 immediately.
    path.write_text(token + "\n", encoding="utf-8")
    # On Windows / some exotic filesystems chmod is a no-op. The file
    # is still under the operator's home directory, so it's reachable
    # only via their account.
    with contextlib.suppress(OSError):
        path.chmod(0o600)

    banner = (
        "\n"
        "────────────────────────────────────────────────────────────\n"
        " Claude Hive — new auth token generated\n"
        "────────────────────────────────────────────────────────────\n"
        f"  token:    {token}\n"
        f"  saved to: {path}\n"
        "\n"
        "  • The dashboard will prompt for this on first load.\n"
        "  • hive-agents in containers need HIVE_AUTH_TOKEN set to\n"
        "    the same value to heartbeat the hub.\n"
        "  • Rotate with `rm` on the token file, then restart the hub.\n"
        "────────────────────────────────────────────────────────────\n"
    )
    sys.stdout.write(banner)
    sys.stdout.flush()
    return token, "generated"


def _is_unauth_path(path: str) -> bool:
    """Return True when ``path`` should bypass the bearer-token check."""
    if path in _UNAUTH_PATHS:
        return True
    # WebSocket endpoints do their own handshake-time auth inside the
    # router (browsers can't attach Authorization headers to the upgrade
    # request, so they negotiate via ?token= instead).
    return path.startswith("/ws")


def _unauthorized(message: str, request: Request) -> Response:
    """401 response with a structured body and CORS-friendly headers."""
    return JSONResponse(
        {"error": "unauthorized", "message": message},
        status_code=status.HTTP_401_UNAUTHORIZED,
        headers={
            # Tell the browser that the Authorization header is a
            # legitimate scheme even though we rejected this request;
            # otherwise retries that attach the header get opaquely
            # blocked by the preflight cache.
            "WWW-Authenticate": 'Bearer realm="honeycomb"',
        },
    )


def _extract_bearer(request: Request) -> str | None:
    """Pull the raw token string out of the Authorization header."""
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[len("Bearer ") :].strip() or None
    return None


class AuthMiddleware(BaseHTTPMiddleware):
    """Enforce bearer-token auth on every HTTP request except the allowlist.

    The token is captured at construction time. Tests can instantiate
    the app with a different token per test. Production callers grab it
    from ``load_or_create_token(settings)`` during lifespan start-up.
    """

    def __init__(self, app, token: str) -> None:
        super().__init__(app)
        self._token = token

    async def dispatch(  # type: ignore[override]
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if _is_unauth_path(request.url.path):
            return await call_next(request)

        supplied = _extract_bearer(request)
        if supplied is None:
            return _unauthorized("missing bearer token", request)
        if not secrets.compare_digest(supplied, self._token):
            return _unauthorized("invalid bearer token", request)

        return await call_next(request)


async def authenticate_websocket(websocket: WebSocket, token: str) -> bool:
    """Validate a WebSocket upgrade. Returns True iff the token is correct.

    On failure, the function closes the socket with code ``1008`` (policy
    violation) and sends a short plain-text reason. Callers should
    ``return`` immediately when this function returns ``False``.
    """
    supplied = websocket.query_params.get("token", "")
    if not supplied or not secrets.compare_digest(supplied, token):
        # ``accept()`` before ``close()`` so the browser actually sees
        # the close frame instead of a generic WebSocket error.
        await websocket.accept()
        await websocket.send_text("s" + "closed:unauthorized")
        await websocket.close(code=1008)
        return False
    return True
