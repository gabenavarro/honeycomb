"""Keybinding overrides REST endpoints (M10).

``GET  /api/keybindings`` returns the persisted overrides.
``PUT  /api/keybindings`` replaces the file entirely with the provided
map — this mirrors VSCode's behaviour where a save writes the full
overrides file, not a diff.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from hub.services.keybindings import load_keybindings, save_keybindings

router = APIRouter(prefix="/api/keybindings", tags=["keybindings"])


class KeybindingsPayload(BaseModel):
    """Full keybinding override set. Keys are dashboard command ids,
    values are shortcut strings (e.g. ``"Ctrl+Shift+K"``)."""

    bindings: dict[str, str]


@router.get("")
async def get_keybindings() -> dict:
    return {"bindings": load_keybindings()}


@router.put("")
async def put_keybindings(payload: KeybindingsPayload) -> dict:
    save_keybindings(payload.bindings)
    return {"bindings": load_keybindings()}
