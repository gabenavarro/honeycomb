"""Container filesystem read endpoints (M17).

These live under ``/api/containers/{id}`` so they inherit the existing
container-scoped URL shape, but are split into their own module to keep
``containers.py`` from growing to fit a different concern.

Endpoints:

- ``GET /api/containers/{id}/workdir`` — inspect the container config
  and return ``Config.WorkingDir``. Zero subprocess round-trips.
- ``GET /api/containers/{id}/fs?path=/abs/path`` — list the contents
  of a directory inside the running container via
  ``docker exec {id} ls -lA --full-time -- <path>``.
"""

from __future__ import annotations

import logging

import docker
import docker.errors
from fastapi import APIRouter, HTTPException, Query, Request

from hub.services.fs_browser import (
    InvalidFsPath,
    parse_ls_output,
    validate_path,
)

logger = logging.getLogger("hub.routers.fs")

router = APIRouter(prefix="/api/containers", tags=["fs"])


async def _lookup_container_id(registry, record_id: int) -> str:
    """Resolve the hub record to its live docker container id. Raises a
    404 / 409 HTTPException when the record is missing or the container
    hasn't been started."""
    try:
        record = await registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container record {record_id} not found")
    if not record.container_id:
        raise HTTPException(409, "Container has no live docker id yet")
    return record.container_id


@router.get("/{record_id}/workdir")
async def get_workdir(record_id: int, request: Request) -> dict:
    """Return the container's Docker-configured WORKDIR, defaulting to
    ``/`` when the image didn't set one."""
    registry = request.app.state.registry
    container_id = await _lookup_container_id(registry, record_id)
    try:
        client = docker.from_env()
        container = client.containers.get(container_id)
    except docker.errors.NotFound:
        raise HTTPException(404, f"Docker container {container_id} not found")
    except docker.errors.DockerException as exc:
        raise HTTPException(502, f"Docker unavailable: {exc}") from exc

    workdir = container.attrs.get("Config", {}).get("WorkingDir") or "/"
    return {"path": workdir}


@router.get("/{record_id}/fs")
async def list_directory(
    record_id: int,
    request: Request,
    path: str = Query(..., description="Absolute directory path inside the container"),
) -> dict:
    """List the contents of ``path`` inside the container.

    Rejects any path that fails :func:`validate_path`. Uses
    ``docker exec`` with an argv list — the path is passed as a single
    positional argument, never interpolated into a shell string.
    """
    try:
        clean_path = validate_path(path)
    except InvalidFsPath as exc:
        raise HTTPException(400, str(exc)) from exc

    registry = request.app.state.registry
    container_id = await _lookup_container_id(registry, record_id)

    try:
        client = docker.from_env()
        container = client.containers.get(container_id)
    except docker.errors.NotFound:
        raise HTTPException(404, f"Docker container {container_id} not found")
    except docker.errors.DockerException as exc:
        raise HTTPException(502, f"Docker unavailable: {exc}") from exc

    # ``--`` separates options from positional args so a future path like
    # ``-l`` can't be re-interpreted as an option by ``ls``.
    cmd = ["ls", "-lA", "--full-time", "--", clean_path]
    try:
        exit_code, output = container.exec_run(cmd, tty=False, demux=False)
    except docker.errors.APIError as exc:
        raise HTTPException(502, f"docker exec failed: {exc}") from exc

    text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else str(output)
    if exit_code != 0:
        # Non-zero from ``ls`` is almost always "No such file or
        # directory" or "Permission denied"; surface verbatim so the
        # UI can show the original message.
        raise HTTPException(400, text.strip() or f"ls exited with {exit_code}")

    entries, truncated = parse_ls_output(text)
    return {
        "path": clean_path,
        "entries": [e.to_dict() for e in entries],
        "truncated": truncated,
    }
