"""Pydantic models for the Claude Hive Hub API."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field

# --- Container ---


class ProjectType(StrEnum):
    BASE = "base"
    ML_CUDA = "ml-cuda"
    WEB_DEV = "web-dev"
    COMPBIO = "compbio"


class ContainerStatus(StrEnum):
    RUNNING = "running"
    STOPPED = "stopped"
    STARTING = "starting"
    ERROR = "error"
    UNKNOWN = "unknown"


class AgentStatus(StrEnum):
    IDLE = "idle"
    BUSY = "busy"
    ERROR = "error"
    UNREACHABLE = "unreachable"


class ContainerCreate(BaseModel):
    """Request to register and provision a new devcontainer."""

    workspace_folder: str = Field(
        ...,
        min_length=1,
        max_length=4096,
        description="Absolute path to the project workspace on the host",
    )
    project_type: ProjectType = Field(default=ProjectType.BASE)
    project_name: str = Field(..., min_length=1, max_length=200)
    project_description: str = Field(default="", max_length=10_000)
    git_repo_url: str | None = Field(
        default=None,
        max_length=2048,
        description="GitHub repo URL if applicable",
    )
    auto_provision: bool = Field(default=True, description="Run bootstrapper on registration")
    auto_start: bool = Field(default=True, description="Start the devcontainer after provisioning")
    force_gpu: bool = Field(
        default=False,
        description="Override the single-GPU exclusivity check. The host has "
        "one GPU; the hub normally rejects a second GPU container so it can "
        "prompt the user before competing for memory. Set true to bypass.",
    )


class ContainerRecord(BaseModel):
    """A registered devcontainer in the hub's registry."""

    id: int
    workspace_folder: str
    project_type: ProjectType
    project_name: str
    project_description: str
    git_repo_url: str | None = None
    container_id: str | None = None
    container_status: ContainerStatus = ContainerStatus.UNKNOWN
    agent_status: AgentStatus = AgentStatus.UNREACHABLE
    # Whether a hive-agent is expected to report heartbeats. False for
    # containers registered via the Discover tab without provisioning —
    # they work over docker_exec only and heartbeat silence is normal.
    # The health checker + dashboard banner consult this flag (M13).
    agent_expected: bool = True
    agent_port: int = 9100
    has_gpu: bool = False
    # Whether Claude Code CLI (`claude`) is on PATH inside the container.
    # Probed at registration and after an install; surfaces to the UI so
    # the Claude tab can show an install gate instead of failing with
    # "claude: not found".
    has_claude_cli: bool = False
    claude_cli_checked_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class ContainerUpdate(BaseModel):
    """Fields that can be updated on a container record."""

    project_name: str | None = Field(default=None, min_length=1, max_length=200)
    project_description: str | None = Field(default=None, max_length=10_000)
    git_repo_url: str | None = Field(default=None, max_length=2048)
    agent_port: int | None = Field(default=None, ge=1, le=65_535)


# --- Heartbeat ---


class HeartbeatPayload(BaseModel):
    """Heartbeat sent from hive-agent inside a container.

    Pre-M4 the agent POSTed this over HTTP; since M4 the same shape
    travels as a ``heartbeat`` frame on the reverse-tunnel WebSocket.
    Kept as a Pydantic model so hub code still speaks the same type in
    both paths.
    """

    container_id: str = Field(..., min_length=1, max_length=128)
    status: str = Field(..., max_length=32)
    agent_port: int = Field(default=9100, ge=1, le=65_535)
    session_info: dict[str, Any] = Field(default_factory=dict)


# --- Events ---


class EventPayload(BaseModel):
    """Event sent from hive-agent inside a container."""

    container_id: str = Field(..., min_length=1, max_length=128)
    event_type: str = Field(..., min_length=1, max_length=64)
    data: dict[str, Any] = Field(default_factory=dict)


# --- Commands ---

# Command strings are passed to a shell inside the container. A 64 KiB
# cap is generous for any real-world paste (shell history lines top out
# in the hundreds of bytes) and defends against a confused caller that
# tries to ship a megabyte of stdin through this channel.
MAX_COMMAND_LENGTH = 65_536


class CommandRequest(BaseModel):
    """Request to execute a command in a devcontainer."""

    command: str = Field(..., min_length=1, max_length=MAX_COMMAND_LENGTH)
    command_id: str | None = Field(default=None, max_length=128)


class CommandResponse(BaseModel):
    """Response after dispatching a command."""

    command_id: str
    pid: int | None = None
    status: str = "dispatched"
    relay_path: str = Field(
        default="agent",
        description="Which path delivered the command: "
        "'agent' | 'devcontainer_exec' | 'docker_exec'.",
    )
    exit_code: int | None = None
    # Synchronous paths (devcontainer_exec, docker_exec) return the full
    # output inline since there's no WebSocket stream to follow. `agent`
    # path leaves these empty — output arrives on the cmd:{id} channel.
    stdout: str | None = None
    stderr: str | None = None


class CommandOutput(BaseModel):
    """Output from a running or completed command."""

    command_id: str
    running: bool
    output: list[str]


# --- Filesystem (M18) ---


class FileContent(BaseModel):
    """Body returned by ``GET /api/containers/{id}/fs/read``.

    The hub ships text files inline as UTF-8 ``content`` (up to
    5 MiB); binary files go through base64 (up to 1 MiB). Larger files
    return ``truncated=true`` with no body — the dashboard offers a
    download link instead of an inline preview.
    """

    path: str
    mime_type: str
    size_bytes: int
    content: str | None = None
    content_base64: str | None = None
    truncated: bool = False
    error: str | None = None


# Keep compatible with the dict-return shape of /fs that test_api uses:
# hub/routers/fs.py currently returns plain dicts for /fs, so we only
# need a Pydantic response_model for /fs/walk where the new code wants
# typed output. No refactor of the existing /fs return shape.


class FsEntry(BaseModel):
    """One directory entry — same shape the `/fs` endpoint returns.

    Kept as a Pydantic model (not just a TypedDict) so FastAPI can
    type-validate the walk payload and so we inherit OpenAPI schema
    generation. The existing `/fs` endpoint still hand-rolls its dict
    response — no churn there.
    """

    name: str
    kind: str  # "file" | "dir" | "symlink" | "other"
    size: int
    mode: str
    mtime: str
    target: str | None = None


class WalkResult(BaseModel):
    """Body returned by `GET /api/containers/{id}/fs/walk`.

    A flat list of every entry under `root`, depth-bounded and
    pruning well-known junk dirs (`.git`, `node_modules`, …). The
    dashboard indexes this for the palette's `file:` mode, the file
    viewer's cross-directory lookups (M24+), and future Claude diff
    hooks (M26 ε).
    """

    root: str
    entries: list[FsEntry]
    truncated: bool
    elapsed_ms: int


# --- Resources ---


class ResourceStats(BaseModel):
    """Resource usage stats for a container."""

    container_id: str
    cpu_percent: float = 0.0
    memory_mb: float = 0.0
    memory_limit_mb: float = 0.0
    memory_percent: float = 0.0
    gpu_utilization: float | None = None
    gpu_memory_mb: float | None = None
    gpu_memory_total_mb: float | None = None
    timestamp: datetime = Field(default_factory=datetime.now)


# --- Git Ops ---


class RepoStatus(BaseModel):
    """Status of a git repository."""

    workspace_folder: str
    repo_url: str | None = None
    branch: str = ""
    ahead: int = 0
    behind: int = 0
    has_upstream: bool = True
    dirty: bool = False
    open_pr_count: int = 0
    last_checked: datetime = Field(default_factory=datetime.now)


class PullRequestSummary(BaseModel):
    """Summary of a pull request."""

    repo: str
    number: int
    title: str
    author: str
    state: str
    created_at: str
    updated_at: str
    url: str
    review_status: str = ""


# --- WebSocket ---


class WSFrame(BaseModel):
    """A tagged WebSocket frame for multiplexed streaming."""

    channel: str  # container registry id or "system"
    event: str  # "output", "status", "heartbeat", "error"
    data: Any


# --- Discovery ---


class WorkspaceCandidate(BaseModel):
    """A workspace folder with a devcontainer config, not yet registered."""

    workspace_folder: str
    project_name: str
    inferred_project_type: str
    has_dockerfile: bool
    has_claude_md: bool
    devcontainer_path: str


class ContainerCandidate(BaseModel):
    """A running Docker container that could be registered with the hub."""

    container_id: str
    name: str
    image: str
    status: str
    inferred_workspace_folder: str | None = None
    inferred_project_name: str
    inferred_project_type: str
    has_hive_agent: bool
    agent_port: int | None = None


class DiscoveryResponse(BaseModel):
    """Combined discovery payload returned by /api/discover."""

    workspaces: list[WorkspaceCandidate]
    containers: list[ContainerCandidate]
    discover_roots: list[str]


class DiscoverRegisterRequest(BaseModel):
    """Register a discovered candidate with minimal typing on the caller's
    side. Exactly one of `workspace_folder` or `container_id` should be
    provided; the other is derived."""

    workspace_folder: str | None = Field(default=None, max_length=4096)
    container_id: str | None = Field(default=None, max_length=128)
    project_name: str = Field(..., min_length=1, max_length=200)
    project_type: ProjectType = ProjectType.BASE
    project_description: str = Field(default="", max_length=10_000)
    # For already-running discovered containers we default to no-provision,
    # no-start; for pure workspace picks the caller can opt in.
    auto_provision: bool = False
    auto_start: bool = False
    force_gpu: bool = False
