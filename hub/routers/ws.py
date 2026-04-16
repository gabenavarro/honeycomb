"""WebSocket router — multiplexed streaming for terminal output and status updates."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from hub.models.schemas import WSFrame
from hub.services import metrics

logger = logging.getLogger("hub.routers.ws")

router = APIRouter(tags=["websocket"])


# Per-client send timeout for broadcasts — a slow client must not block
# the rest of the fleet. Client that exceeds this is disconnected.
BROADCAST_CLIENT_TIMEOUT_SECONDS = 2.0


class ConnectionManager:
    """Manages WebSocket connections and channel subscriptions."""

    def __init__(self) -> None:
        self._connections: list[WebSocket] = []
        self._subscriptions: dict[int, set[str]] = {}  # ws_id -> set of channels

    async def connect(self, websocket: WebSocket) -> int:
        await websocket.accept()
        ws_id = id(websocket)
        self._connections.append(websocket)
        self._subscriptions[ws_id] = {"system"}  # Always subscribed to system
        metrics.ws_clients.set(len(self._connections))
        logger.info("WebSocket connected: %d (total: %d)", ws_id, len(self._connections))
        return ws_id

    def disconnect(self, websocket: WebSocket) -> None:
        ws_id = id(websocket)
        if websocket in self._connections:
            self._connections.remove(websocket)
        self._subscriptions.pop(ws_id, None)
        metrics.ws_clients.set(len(self._connections))
        logger.info("WebSocket disconnected: %d (total: %d)", ws_id, len(self._connections))

    def subscribe(self, websocket: WebSocket, channels: list[str]) -> None:
        ws_id = id(websocket)
        subs = self._subscriptions.get(ws_id, set())
        subs.update(channels)
        self._subscriptions[ws_id] = subs

    def unsubscribe(self, websocket: WebSocket, channels: list[str]) -> None:
        ws_id = id(websocket)
        subs = self._subscriptions.get(ws_id, set())
        subs -= set(channels)
        self._subscriptions[ws_id] = subs

    async def _send_one(self, ws: WebSocket, message: str) -> bool:
        """Send to a single client with a timeout. Returns False on failure."""
        try:
            await asyncio.wait_for(ws.send_text(message), timeout=BROADCAST_CLIENT_TIMEOUT_SECONDS)
            return True
        except Exception:
            return False

    async def broadcast(self, frame: WSFrame) -> None:
        """Send a frame to all WebSocket connections subscribed to its channel.

        Sends run concurrently with a per-client timeout so a single slow or
        hung client cannot delay delivery to the rest of the fleet. Failed
        clients are disconnected.
        """
        message = frame.model_dump_json()
        targets: list[WebSocket] = []
        for ws in list(self._connections):
            ws_id = id(ws)
            subs = self._subscriptions.get(ws_id, set())
            if frame.channel in subs or frame.channel == "system":
                targets.append(ws)

        if not targets:
            return

        results = await asyncio.gather(
            *(self._send_one(ws, message) for ws in targets),
            return_exceptions=False,
        )
        for ws, ok in zip(targets, results, strict=False):
            if not ok:
                self.disconnect(ws)

    async def send_to(self, websocket: WebSocket, frame: WSFrame) -> None:
        """Send a frame to a specific WebSocket connection."""
        ok = await self._send_one(websocket, frame.model_dump_json())
        if not ok:
            self.disconnect(websocket)


# Global connection manager instance
manager = ConnectionManager()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Multiplexed WebSocket endpoint.

    Clients send JSON messages to subscribe/unsubscribe to container channels:
        {"action": "subscribe", "channels": ["1", "2", "3"]}
        {"action": "unsubscribe", "channels": ["2"]}

    Server sends tagged frames:
        {"channel": "1", "event": "output", "data": "..."}
        {"channel": "system", "event": "status", "data": {...}}
    """
    ws_id = await manager.connect(websocket)

    # Send welcome
    await manager.send_to(
        websocket,
        WSFrame(
            channel="system",
            event="connected",
            data={"ws_id": ws_id},
        ),
    )

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await manager.send_to(
                    websocket,
                    WSFrame(
                        channel="system",
                        event="error",
                        data={"message": "Invalid JSON"},
                    ),
                )
                continue

            action = msg.get("action")
            channels = msg.get("channels", [])

            if action == "subscribe":
                manager.subscribe(websocket, channels)
                await manager.send_to(
                    websocket,
                    WSFrame(
                        channel="system",
                        event="subscribed",
                        data={"channels": channels},
                    ),
                )
            elif action == "unsubscribe":
                manager.unsubscribe(websocket, channels)
                await manager.send_to(
                    websocket,
                    WSFrame(
                        channel="system",
                        event="unsubscribed",
                        data={"channels": channels},
                    ),
                )
            else:
                await manager.send_to(
                    websocket,
                    WSFrame(
                        channel="system",
                        event="error",
                        data={"message": f"Unknown action: {action}"},
                    ),
                )

    except WebSocketDisconnect:
        manager.disconnect(websocket)
