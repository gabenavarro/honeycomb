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

import base64
import logging
import mimetypes
from collections.abc import Iterator

import docker
import docker.errors
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from hub.models.schemas import FileContent
from hub.services.fs_browser import (
    MAX_BINARY_BYTES,
    MAX_TEXT_BYTES,
    InvalidFsPath,
    is_text_mime,
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


def _sniff_mime(container, path: str) -> str:
    """Best-effort MIME-type detection. First try ``file --mime-type``
    inside the container; fall back to Python's ``mimetypes`` mapping
    on extension if the external tool isn't present (Alpine without
    ``file`` package, etc.)."""
    try:
        exit_code, output = container.exec_run(
            ["file", "--mime-type", "--brief", "--", path],
            tty=False,
            demux=False,
        )
        if exit_code == 0 and output:
            text = output.decode("utf-8", errors="replace").strip()
            if text:
                return text
    except docker.errors.APIError:
        pass
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


@router.get("/{record_id}/fs/read", response_model=FileContent)
async def read_file(
    record_id: int,
    request: Request,
    path: str = Query(..., description="Absolute file path inside the container"),
) -> FileContent:
    """Return the contents of ``path``. Text up to 5 MiB inline as
    ``content``; binary up to 1 MiB as base64 in ``content_base64``;
    larger → ``truncated=true`` with no body (use ``?download=1``)."""
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

    # ``stat -c %s`` gives the size cheaply without reading the body.
    try:
        exit_code, output = container.exec_run(
            ["stat", "-c", "%s", "--", clean_path], tty=False, demux=False
        )
    except docker.errors.APIError as exc:
        raise HTTPException(502, f"stat failed: {exc}") from exc
    if exit_code != 0:
        text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else ""
        raise HTTPException(400, text.strip() or f"stat exited with {exit_code}")
    try:
        size_bytes = int(output.decode("utf-8").strip())
    except (ValueError, AttributeError):
        raise HTTPException(502, "stat returned unparseable size")

    mime = _sniff_mime(container, clean_path)
    text_like = is_text_mime(mime)
    cap = MAX_TEXT_BYTES if text_like else MAX_BINARY_BYTES
    if size_bytes > cap:
        return FileContent(
            path=clean_path,
            mime_type=mime,
            size_bytes=size_bytes,
            truncated=True,
        )

    try:
        exit_code, output = container.exec_run(["cat", "--", clean_path], tty=False, demux=False)
    except docker.errors.APIError as exc:
        raise HTTPException(502, f"cat failed: {exc}") from exc
    if exit_code != 0:
        text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else ""
        raise HTTPException(400, text.strip() or f"cat exited with {exit_code}")

    body = output if isinstance(output, bytes) else bytes(output or b"")

    if text_like:
        try:
            return FileContent(
                path=clean_path,
                mime_type=mime,
                size_bytes=size_bytes,
                content=body.decode("utf-8"),
            )
        except UnicodeDecodeError:
            # Claimed text but isn't valid UTF-8 — fall through to base64.
            pass
    return FileContent(
        path=clean_path,
        mime_type=mime,
        size_bytes=size_bytes,
        content_base64=base64.b64encode(body).decode("ascii"),
    )


@router.get("/{record_id}/fs/download")
async def download_file(
    record_id: int,
    request: Request,
    path: str = Query(..., description="Absolute file path inside the container"),
) -> StreamingResponse:
    """Stream the file without the size cap. For binaries the browser
    saves directly; the Content-Disposition hints the filename."""
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

    try:
        exit_code, output = container.exec_run(["cat", "--", clean_path], tty=False, demux=False)
    except docker.errors.APIError as exc:
        raise HTTPException(502, f"cat failed: {exc}") from exc
    if exit_code != 0:
        text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else ""
        raise HTTPException(400, text.strip() or f"cat exited with {exit_code}")

    body = output if isinstance(output, bytes) else bytes(output or b"")
    filename = clean_path.rsplit("/", 1)[-1] or "file"

    def _iter() -> Iterator[bytes]:
        yield body

    return StreamingResponse(
        _iter(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
