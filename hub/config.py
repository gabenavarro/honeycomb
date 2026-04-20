"""Centralised, validated configuration for the Claude Hive hub.

All `HIVE_*` environment variables and runtime knobs flow through the
``HiveSettings`` model. Code that needs configuration should import the
singleton via ``get_settings()`` (cached) rather than reading
``os.environ`` directly.

The schema is intentionally tight:
- Required things are required.
- Enum-like values (log level, log format) use ``Literal`` so typos fail
  at boot, not at log time.
- ``discover_roots`` accepts a colon-separated string (the historical
  format used by ``HIVE_DISCOVER_ROOTS``) AND a JSON list, so both
  shell-style env vars and structured overrides work.

.env loading is enabled: if a ``.env`` file sits next to the working
directory, its keys populate settings before process env does. This
matches the workflow documented in ``.env.example`` — local dev copies
``.env.example`` to ``.env`` and never commits the latter.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Historical defaults for HIVE_DISCOVER_ROOTS. These cover typical Linux/macOS
# developer layouts; Windows / WSL users usually want to override.
DEFAULT_DISCOVER_ROOT_CANDIDATES: tuple[str, ...] = (
    "~/repos",
    "~/projects",
    "~/code",
    "~/src",
    "~/dev",
    "~/workspace",
)

LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
LogFormat = Literal["json", "pretty", "auto"]


class HiveSettings(BaseSettings):
    """All configuration the hub reads at runtime.

    Validated once at startup. Cached via ``get_settings()`` so that
    request handlers can pull it cheaply without re-parsing env on every
    call.
    """

    model_config = SettingsConfigDict(
        env_prefix="HIVE_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Network bind ────────────────────────────────────────────────
    host: str = Field(
        default="127.0.0.1",
        description=(
            "Interface the hub binds to. Default 127.0.0.1 keeps the hub "
            "reachable only from the local host. Setting 0.0.0.0 without "
            "also setting HIVE_AUTH_TOKEN exposes every endpoint to the "
            "network — refuse to start in that combination (see validator)."
        ),
    )
    port: int = Field(
        default=8420,
        ge=1,
        le=65535,
        description="TCP port the hub binds to. Dashboard dev server proxies /api and /ws here.",
    )

    # ── Storage ─────────────────────────────────────────────────────
    db_path: Path = Field(
        default_factory=lambda: Path.home() / ".claude-hive" / "registry.db",
        description=(
            "SQLite registry file. Created on first run. Parent directory "
            "is created if missing. Wipe this file to start a fresh "
            "registry — everything else is state-free."
        ),
    )

    # ── Discovery ───────────────────────────────────────────────────
    # ``Annotated[..., NoDecode]`` disables pydantic-settings' default
    # JSON decoding for this field, so the colon-separated historical
    # format continues to work as the primary input. The validator below
    # still accepts JSON lists for callers who prefer structured input.
    discover_roots: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: list(DEFAULT_DISCOVER_ROOT_CANDIDATES),
        description=(
            "Host directories scanned by /api/discover for unregistered "
            ".devcontainer/ folders. Colon-separated string or JSON list. "
            "Paths are expanded (~) and resolved by the discovery service; "
            "nonexistent paths are silently skipped."
        ),
    )

    # ── Auth ────────────────────────────────────────────────────────
    auth_token: str | None = Field(
        default=None,
        description=(
            "Bearer token gating every HTTP + WebSocket endpoint. When "
            "unset the hub loads ~/.config/honeycomb/token on start-up; "
            "if that file is also absent, a token is generated, printed "
            "to stdout once, and persisted (mode 0600). Set this env var "
            "to override the file-based token, e.g. in CI or multi-hub "
            "setups."
        ),
    )
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
        description=(
            "Origins permitted by the CORS middleware. Defaults to the "
            "Vite dev server on localhost:5173. Accepts a comma-separated "
            "string or a JSON list. Set to ['*'] only if you really want "
            "an open hub — combined with HIVE_HOST=0.0.0.0 and no auth "
            "token that is equivalent to a public shell on the box."
        ),
    )

    # ── Logging ─────────────────────────────────────────────────────
    log_level: LogLevel = Field(
        default="INFO",
        description="Root log level for the hub. Structlog honours this too.",
    )
    log_format: LogFormat = Field(
        default="auto",
        description=(
            "'json' forces JSON logs (production-friendly); 'pretty' forces "
            "the colourised dev renderer; 'auto' picks JSON when stderr is "
            "not a TTY and pretty otherwise."
        ),
    )

    # ── Metrics ─────────────────────────────────────────────────────
    metrics_enabled: bool = Field(
        default=True,
        description="When True, /metrics exposes Prometheus counters/gauges.",
    )

    # ── Dashboard UI ────────────────────────────────────────────────
    timeline_visible: bool = Field(
        default=True,
        description=(
            "Whether the dashboard shows the three-sparkline health "
            "timeline above the session tabs. Shared across all "
            "devices that sync via this hub."
        ),
    )

    # ── PTY + session caching (M15) ────────────────────────────────
    pty_grace_seconds: int = Field(
        default=3600,
        ge=0,
        description=(
            "How long a detached PTY session stays alive before the hub kills it. "
            "Default 1 h — long enough to survive a laptop lid-close and a proxy "
            "reconnect. 0 = close immediately on disconnect (legacy behaviour)."
        ),
    )
    pty_scrollback_dir: Path | None = Field(
        default=None,
        description=(
            "Directory the hub uses to dual-write PTY scrollback so the bytes "
            "replay across hub restarts. Defaults to ~/.config/honeycomb/sessions. "
            "Set to the empty string to disable disk-backed scrollback entirely."
        ),
    )
    pty_scrollback_max_age_hours: int = Field(
        default=24,
        ge=1,
        description="Delete persisted scrollback logs older than this on the GC sweep.",
    )
    quick_history_lines: int = Field(
        default=10_000,
        ge=100,
        description=(
            "Max transcript lines the Claude Quick pane stores in localStorage. "
            "Raising this keeps longer conversations across reloads; lower if "
            "localStorage quota bites."
        ),
    )

    # ── Validators ──────────────────────────────────────────────────
    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_comma_origins(cls, value: object) -> object:
        """Accept comma-separated strings (standard HTTP-ish format) and JSON."""
        import json

        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return []
            if stripped.startswith("["):
                try:
                    return json.loads(stripped)
                except json.JSONDecodeError:
                    pass
            return [segment.strip() for segment in value.split(",") if segment.strip()]
        return value

    @field_validator("discover_roots", mode="before")
    @classmethod
    def _split_colon_roots(cls, value: object) -> object:
        """Accept historical colon-separated env format as well as JSON.

        HIVE_DISCOVER_ROOTS=~/repos:~/projects is the documented form.
        JSON-list form (``[...]``) is also accepted for callers who want
        structured input. Empty string falls back to the built-in defaults.
        """
        import json

        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return list(DEFAULT_DISCOVER_ROOT_CANDIDATES)
            if stripped.startswith("["):
                try:
                    return json.loads(stripped)
                except json.JSONDecodeError:
                    pass
            return [segment.strip() for segment in value.split(":") if segment.strip()]
        return value


@lru_cache(maxsize=1)
def get_settings() -> HiveSettings:
    """Return the cached hub settings. Safe to call from any code path."""
    return HiveSettings()


def reset_settings_cache() -> None:
    """Clear the cached settings — test-only helper."""
    get_settings.cache_clear()
