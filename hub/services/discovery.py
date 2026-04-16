"""Discovery service — find unregistered devcontainers and workspace folders.

This module is read-only: it produces *candidates* for registration. The
existing autodiscovery flow (hub/services/autodiscovery.py) delegates its
scan step here and then registers the results, while the /api/discover/*
endpoints expose these candidates to the dashboard so the user can pick
from a list instead of typing paths.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path

import docker
import docker.errors
import httpx

from hub.config import get_settings
from hub.services.registry import Registry

logger = logging.getLogger("hub.discovery")

# Common host paths we search by default when the operator hasn't set
# HIVE_DISCOVER_ROOTS. These match typical Linux/Mac developer layouts;
# Windows/WSL users should set HIVE_DISCOVER_ROOTS explicitly.
DEFAULT_DISCOVER_ROOT_CANDIDATES = (
    "~/repos",
    "~/projects",
    "~/code",
    "~/src",
    "~/dev",
    "~/workspace",
)

# How deep under each root to search for .devcontainer/devcontainer.json.
# 2 is enough for ~/repos/<project>/.devcontainer/... while keeping scans
# cheap on large trees.
MAX_DISCOVER_DEPTH = 3


@dataclass
class WorkspaceCandidate:
    """A workspace folder with a devcontainer config, not yet registered."""

    workspace_folder: str
    project_name: str
    inferred_project_type: str  # "base" | "ml-cuda" | "web-dev" | "compbio"
    has_dockerfile: bool
    has_claude_md: bool
    devcontainer_path: str


@dataclass
class ContainerCandidate:
    """A running Docker container that could be registered with the hub."""

    container_id: str  # short id
    name: str
    image: str
    status: str
    inferred_workspace_folder: str | None
    inferred_project_name: str
    inferred_project_type: str
    has_hive_agent: bool
    agent_port: int | None


# ──────────────────────────────────────────────────────────────────────────
# Project-type inference
# ──────────────────────────────────────────────────────────────────────────

# Ordered: first matching rule wins. Keyed for visibility in tests.
# We don't use strict \b word boundaries for tokens that commonly appear
# in compound names like `pytorch_lightning` or `"next"` — `_` is a word
# char so `\b` wouldn't match between `pytorch` and `_lightning`.
_TYPE_SIGNALS: list[tuple[str, tuple[re.Pattern, ...]]] = [
    (
        "ml-cuda",
        (
            re.compile(
                r"(?<![a-z])(cuda|nvidia|--gpus|pytorch|tensorflow|huggingface|torch|transformers)(?![a-z])",
                re.I,
            ),
            re.compile(r"pytorch[_\-]?lightning", re.I),
            re.compile(r"nvcr\.io/nvidia/", re.I),
        ),
    ),
    (
        "compbio",
        (
            re.compile(
                r"(?<![a-z])(scanpy|biopython|scvi-tools|esm|pysam|bioconductor)(?![a-z])",
                re.I,
            ),
            re.compile(
                r"(?<![a-z])(bcftools|samtools|seqkit|minimap2)(?![a-z])",
                re.I,
            ),
        ),
    ),
    (
        "web-dev",
        (
            re.compile(
                r"(?<![a-z])(next|nextjs|react|vite|fastapi|express|nuxt)(?![a-z])",
                re.I,
            ),
            re.compile(r"\"node\":\s*\">=", re.I),
        ),
    ),
]


def infer_project_type(*text_sources: str) -> str:
    """Best-effort classification from any concatenation of text.

    We treat `base` as the default — "unknown" is not a user-facing type.
    Callers typically pass the devcontainer.json contents, the Dockerfile
    (if present), and/or pyproject.toml / package.json snippets.
    """
    haystack = "\n".join(s for s in text_sources if s)
    for label, patterns in _TYPE_SIGNALS:
        if any(p.search(haystack) for p in patterns):
            return label
    return "base"


# ──────────────────────────────────────────────────────────────────────────
# Workspace discovery
# ──────────────────────────────────────────────────────────────────────────


def _discover_roots() -> list[Path]:
    """Return the list of discover roots, filtered to existing directories.

    The raw list of candidate strings comes from ``HiveSettings.discover_roots``,
    which in turn accepts either the historical ``HIVE_DISCOVER_ROOTS``
    colon-separated format or a JSON list. Paths are expanded (``~``) and
    resolved here. Nonexistent paths are dropped silently — we don't
    want to spam warnings on hosts missing a particular convention.
    """
    candidates = get_settings().discover_roots or list(DEFAULT_DISCOVER_ROOT_CANDIDATES)
    roots: list[Path] = []
    for c in candidates:
        p = Path(os.path.expanduser(str(c))).resolve()
        if p.is_dir():
            roots.append(p)
    return roots


def _read_text_safely(path: Path, limit: int = 65_536) -> str:
    """Best-effort read, truncated. Missing/permission/decoding errors → ''."""
    try:
        with path.open("rb") as f:
            blob = f.read(limit)
        return blob.decode("utf-8", errors="replace")
    except OSError:
        return ""


def _workspace_name(workspace: Path) -> str:
    """Derive a display name from the devcontainer.json `name` field,
    falling back to the folder basename."""
    cfg_path = workspace / ".devcontainer" / "devcontainer.json"
    text = _read_text_safely(cfg_path)
    if text:
        # devcontainer.json allows // and /* */ comments — strip before
        # parsing. A fuller JSONC parser would be overkill here; the
        # fallback handles parse failures anyway.
        no_line_comments = re.sub(r"//.*$", "", text, flags=re.MULTILINE)
        no_block_comments = re.sub(r"/\*.*?\*/", "", no_line_comments, flags=re.DOTALL)
        try:
            cfg = json.loads(no_block_comments)
            name = cfg.get("name")
            if isinstance(name, str) and name.strip():
                return name.strip()
        except json.JSONDecodeError:
            pass
    return workspace.name


def scan_workspace_candidates(
    registered_folders: set[str],
    roots: list[Path] | None = None,
) -> list[WorkspaceCandidate]:
    """Walk discover roots for `.devcontainer/devcontainer.json`, excluding
    workspaces already registered.

    Pure function over the filesystem — safe to call from request handlers.
    """
    roots = roots if roots is not None else _discover_roots()
    candidates: list[WorkspaceCandidate] = []
    seen: set[str] = set()

    for root in roots:
        # Depth-bounded walk so a huge ~/repos doesn't stall the scan.
        root_depth = len(root.parts)
        for dirpath, dirnames, _ in os.walk(root, followlinks=False):
            current_depth = len(Path(dirpath).parts) - root_depth
            if current_depth >= MAX_DISCOVER_DEPTH:
                dirnames[:] = []
                continue
            # Prune common noise directories for speed.
            dirnames[:] = [d for d in dirnames if not d.startswith(".") or d == ".devcontainer"]
            dirnames[:] = [
                d
                for d in dirnames
                if d
                not in {"node_modules", "__pycache__", "target", "dist", "build", ".venv", "venv"}
            ]

            current = Path(dirpath)
            devcontainer = current / ".devcontainer" / "devcontainer.json"
            if not devcontainer.is_file():
                continue

            workspace = str(current.resolve())
            if workspace in registered_folders or workspace in seen:
                continue
            seen.add(workspace)

            dockerfile = current / "Dockerfile"
            if not dockerfile.is_file():
                dockerfile = current / ".devcontainer" / "Dockerfile"
            has_dockerfile = dockerfile.is_file()

            # Concatenate a few signal files for type inference. Each is
            # tiny (or we truncate), so this remains cheap.
            signals = "\n".join(
                _read_text_safely(current / p)
                for p in (
                    ".devcontainer/devcontainer.json",
                    "Dockerfile",
                    ".devcontainer/Dockerfile",
                    "pyproject.toml",
                    "package.json",
                )
            )
            inferred = infer_project_type(signals)

            candidates.append(
                WorkspaceCandidate(
                    workspace_folder=workspace,
                    project_name=_workspace_name(current),
                    inferred_project_type=inferred,
                    has_dockerfile=has_dockerfile,
                    has_claude_md=(current / "CLAUDE.md").is_file(),
                    devcontainer_path=str(devcontainer.resolve()),
                )
            )

    # Sort for stable output — useful for tests and for a predictable UI.
    candidates.sort(key=lambda c: c.workspace_folder)
    return candidates


# ──────────────────────────────────────────────────────────────────────────
# Container discovery
# ──────────────────────────────────────────────────────────────────────────


async def _probe_hive_agent(ip: str, port: int, timeout: float = 1.5) -> bool:
    """Fast check: does hive-agent answer on this IP:port?"""
    try:
        async with httpx.AsyncClient(timeout=timeout) as http:
            resp = await http.get(f"http://{ip}:{port}/health")
            return resp.status_code == 200
    except (httpx.HTTPError, OSError):
        return False


def _infer_workspace_from_container(container) -> str | None:
    """Extract the host workspace folder from a container's devcontainer
    labels or its bind mounts. Returns None when nothing credible matches."""
    labels = container.labels or {}
    # Standard devcontainer label set by the CLI.
    local_folder = labels.get("devcontainer.local_folder")
    if local_folder:
        return local_folder
    # Docker Compose working dir — reasonable proxy.
    compose_dir = labels.get("com.docker.compose.project.working_dir")
    if compose_dir:
        return compose_dir
    # Last resort: look for a bind mount whose target is /workspace/*.
    for mount in container.attrs.get("Mounts", []) or []:
        if mount.get("Type") == "bind":
            dest = mount.get("Destination", "")
            if dest.startswith("/workspace") or dest == "/workspaces":
                src = mount.get("Source")
                if src:
                    return src
    return None


def _infer_container_project_name(container, workspace: str | None) -> str:
    """Choose the best human-readable name: devcontainer.config_file dir,
    workspace basename, or container name."""
    labels = container.labels or {}
    cfg = labels.get("devcontainer.config_file")
    if cfg:
        # config_file looks like `/host/path/.devcontainer/devcontainer.json`
        parts = Path(cfg).parts
        for i, part in enumerate(parts):
            if part == ".devcontainer" and i > 0:
                return parts[i - 1]
    if workspace:
        return Path(workspace).name
    return container.name or container.short_id


async def scan_container_candidates(
    registered_container_ids: set[str],
) -> list[ContainerCandidate]:
    """Return running Docker containers that are not already registered.

    Probes each container for hive-agent on port 9100 in parallel so we
    don't serialize a bunch of 1.5s timeouts when several containers lack
    the agent.
    """
    try:
        client = docker.from_env()
    except docker.errors.DockerException as exc:
        logger.warning("Docker not available for discovery: %s", exc)
        return []

    try:
        running = client.containers.list(filters={"status": "running"})
    except docker.errors.DockerException as exc:
        logger.warning("docker ps failed: %s", exc)
        return []

    # Collect (container, probe-ip, probe-port). We only probe the first
    # network interface that has an IP — more than one is rare and the
    # extra round-trips aren't worth it.
    probe_targets: list[tuple[object, str | None, int]] = []
    for c in running:
        if c.short_id in registered_container_ids:
            continue
        ip: str | None = None
        for net_info in (c.attrs.get("NetworkSettings", {}).get("Networks") or {}).values():
            candidate = net_info.get("IPAddress")
            if candidate:
                ip = candidate
                break
        probe_targets.append((c, ip, 9100))

    import asyncio as _asyncio

    async def _probe_one(container, ip: str | None, port: int) -> bool:
        if not ip:
            return False
        return await _probe_hive_agent(ip, port)

    probe_results: list[bool] = list(
        await _asyncio.gather(
            *(_probe_one(c, ip, port) for c, ip, port in probe_targets),
            return_exceptions=False,
        )
    )

    candidates: list[ContainerCandidate] = []
    for (container, _ip, _port), has_agent in zip(probe_targets, probe_results, strict=False):
        workspace = _infer_workspace_from_container(container)
        name = _infer_container_project_name(container, workspace)
        # Image tag is usually the strongest signal for GPU images.
        image = ""
        try:
            image = (container.image.tags or [container.image.id or ""])[0]
        except Exception:
            image = ""
        inferred = infer_project_type(image, name, (container.name or ""))
        candidates.append(
            ContainerCandidate(
                container_id=container.short_id,
                name=container.name or container.short_id,
                image=image,
                status=container.status,
                inferred_workspace_folder=workspace,
                inferred_project_name=name,
                inferred_project_type=inferred,
                has_hive_agent=has_agent,
                agent_port=9100 if has_agent else None,
            )
        )

    candidates.sort(key=lambda c: c.name)
    return candidates


# ──────────────────────────────────────────────────────────────────────────
# Convenience for the startup auto-register path
# ──────────────────────────────────────────────────────────────────────────


async def registered_filter_sets(registry: Registry) -> tuple[set[str], set[str]]:
    """Return (registered_workspace_folders, registered_container_ids) for
    use as exclusion sets by the scanners above."""
    records = await registry.list_all()
    return (
        {r.workspace_folder for r in records},
        {r.container_id for r in records if r.container_id},
    )
