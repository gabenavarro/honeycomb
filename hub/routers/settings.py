"""Settings REST endpoints (M10).

``GET  /api/settings`` returns the live ``HiveSettings`` as a dict
annotated with which fields are mutable at runtime. The Settings view
renders all fields, but only mutable ones are editable.

``PATCH /api/settings`` applies a partial update to the mutable fields,
persists the new values to ``~/.config/honeycomb/settings.json``, and
mutates the in-memory settings + logging config where appropriate. A
422 is returned if a client asks to mutate a non-mutable field, so
accidental POSTs can't silently rewrite bind addresses or auth tokens.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from hub.config import HiveSettings
from hub.logging_setup import update_log_level
from hub.services.settings_overrides import (
    MUTABLE_FIELDS,
    load_overrides,
    save_overrides,
)

logger = logging.getLogger("hub.routers.settings")

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsPatch(BaseModel):
    """Partial update payload. Only mutable fields are accepted — the
    validator rejects unknown keys up-front so the client gets a clear
    422 instead of a silent no-op.
    """

    model_config = ConfigDict(extra="forbid")

    log_level: str | None = None
    discover_roots: list[str] | None = None
    metrics_enabled: bool | None = None
    timeline_visible: bool | None = None


def _settings_to_dict(settings: HiveSettings) -> dict[str, Any]:
    raw = settings.model_dump(mode="json")
    return {
        "values": raw,
        "mutable_fields": sorted(MUTABLE_FIELDS),
    }


@router.get("")
async def get_settings_endpoint(request: Request) -> dict[str, Any]:
    """Return the current hub settings plus the list of mutable fields."""
    settings: HiveSettings = request.app.state.settings
    return _settings_to_dict(settings)


@router.patch("")
async def patch_settings_endpoint(
    request: Request,
    payload: SettingsPatch,
) -> dict[str, Any]:
    """Apply a partial settings update."""
    settings: HiveSettings = request.app.state.settings

    provided = payload.model_dump(exclude_none=True)
    if not provided:
        raise HTTPException(400, "No fields to update")

    for key in provided:
        if key not in MUTABLE_FIELDS:
            # model_config=extra='forbid' should already catch unknown
            # keys, but be defensive in case someone extends the model
            # with a new read-only field later.
            raise HTTPException(422, f"Field is not mutable at runtime: {key}")

    # Validate the patched values by building a fresh HiveSettings with
    # the merged dict — pydantic enforces the Literal/enum types, so an
    # invalid log_level (e.g. "verbose") fails here instead of silently
    # landing in the JSON file.
    current = settings.model_dump()
    current.update(provided)
    try:
        new_settings = HiveSettings(**current)
    except Exception as exc:
        raise HTTPException(422, f"Invalid settings: {exc}") from exc

    # Merge on top of any already-persisted overrides and save.
    merged = load_overrides()
    merged.update(provided)
    save_overrides(merged)

    # Apply in-process wherever safe. discover_roots is read on every
    # call to the discovery service, so just replace the list. log_level
    # needs the structlog handlers rebound. metrics_enabled flips the
    # /metrics endpoint gate on the next request — no rebind needed.
    for key in provided:
        setattr(settings, key, getattr(new_settings, key))
    if "log_level" in provided:
        update_log_level(settings.log_level)

    logger.info("settings_updated %s", sorted(provided.keys()))
    return _settings_to_dict(settings)
