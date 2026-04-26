"""Artifacts router (M35).

Endpoints:
  - GET  /api/containers/{cid}/artifacts                — list (filterable)
  - POST /api/containers/{cid}/artifacts                — create (client-initiated)
  - GET  /api/artifacts/{artifact_id}                   — fetch one
  - POST /api/artifacts/{artifact_id}/pin               — pin
  - POST /api/artifacts/{artifact_id}/unpin             — unpin
  - POST /api/artifacts/{artifact_id}/archive           — archive
  - DELETE /api/artifacts/{artifact_id}                 — hard-delete

Edit-type artifacts (artifact_id prefixed 'edit-') are synthesized
from diff_events; pin/unpin/archive/delete on those silently no-op
at the service layer.

Mutators (pin/unpin/archive/delete) are idempotent and return 204 even for
unknown artifact_ids; clients should refetch to confirm state.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from hub.models.schemas import Artifact, ArtifactType
from hub.services.artifacts import (
    archive_artifact,
    delete_artifact,
    get_artifact,
    list_artifacts,
    pin_artifact,
    record_artifact,
    unpin_artifact,
)

router = APIRouter(tags=["artifacts"])


class CreateArtifactRequest(BaseModel):
    type: ArtifactType
    title: str = Field(min_length=1, max_length=400)
    body: str = Field(min_length=1, max_length=1_000_000)
    body_format: str = "markdown"
    source_chat_id: str | None = None
    source_message_id: str | None = None
    metadata: dict[str, Any] | None = None


async def _lookup_container(registry, record_id: int) -> None:
    try:
        await registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container record {record_id} not found")


@router.get(
    "/api/containers/{record_id}/artifacts",
    response_model=list[Artifact],
)
async def list_container_artifacts(
    record_id: int,
    request: Request,
    type: list[ArtifactType] | None = Query(default=None),
    search: str | None = Query(default=None),
    archived: bool = Query(default=False),
) -> list[Artifact]:
    registry = request.app.state.registry
    await _lookup_container(registry, record_id)
    return await list_artifacts(
        registry.engine,
        container_id=record_id,
        types=type,
        search=search,
        include_archived=archived,
    )


@router.post(
    "/api/containers/{record_id}/artifacts",
    response_model=Artifact,
    status_code=201,
)
async def create_container_artifact(
    record_id: int,
    request: Request,
    body: CreateArtifactRequest,
) -> Artifact:
    registry = request.app.state.registry
    await _lookup_container(registry, record_id)
    return await record_artifact(
        registry.engine,
        container_id=record_id,
        type=body.type,
        title=body.title,
        body=body.body,
        body_format=body.body_format,
        source_chat_id=body.source_chat_id,
        source_message_id=body.source_message_id,
        metadata=body.metadata,
    )


@router.get(
    "/api/artifacts/{artifact_id}",
    response_model=Artifact,
)
async def get_artifact_endpoint(artifact_id: str, request: Request) -> Artifact:
    registry = request.app.state.registry
    art = await get_artifact(registry.engine, artifact_id=artifact_id)
    if art is None:
        raise HTTPException(404, f"Artifact {artifact_id} not found")
    return art


@router.post("/api/artifacts/{artifact_id}/pin", status_code=204)
async def pin_endpoint(artifact_id: str, request: Request) -> None:
    registry = request.app.state.registry
    await pin_artifact(registry.engine, artifact_id=artifact_id)


@router.post("/api/artifacts/{artifact_id}/unpin", status_code=204)
async def unpin_endpoint(artifact_id: str, request: Request) -> None:
    registry = request.app.state.registry
    await unpin_artifact(registry.engine, artifact_id=artifact_id)


@router.post("/api/artifacts/{artifact_id}/archive", status_code=204)
async def archive_endpoint(artifact_id: str, request: Request) -> None:
    registry = request.app.state.registry
    await archive_artifact(registry.engine, artifact_id=artifact_id)


@router.delete("/api/artifacts/{artifact_id}", status_code=204)
async def delete_endpoint(artifact_id: str, request: Request) -> None:
    registry = request.app.state.registry
    await delete_artifact(registry.engine, artifact_id=artifact_id)
