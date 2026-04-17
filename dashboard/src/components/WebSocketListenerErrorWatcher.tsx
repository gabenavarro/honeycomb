/** Surfaces ``onWebSocketListenerError`` events as a rate-limited
 * warning toast. Rate-limiting is deliberately aggressive (30s) because
 * a thrown listener is almost always a symptom of a React bug that
 * repeats on every frame — one toast tells the story, a hundred
 * obscure it. */

import { useEffect, useRef } from "react";

import { useToasts } from "../hooks/useToasts";
import { onWebSocketListenerError } from "../hooks/useWebSocket";

const RATE_LIMIT_MS = 30_000;

export function WebSocketListenerErrorWatcher() {
  const { toast } = useToasts();
  const lastToastAt = useRef(0);

  useEffect(() => {
    return onWebSocketListenerError(({ channel, error }) => {
      const now = Date.now();
      if (now - lastToastAt.current < RATE_LIMIT_MS) return;
      lastToastAt.current = now;
      const msg = error instanceof Error ? error.message : String(error);
      toast(
        "warning",
        "UI listener error",
        `A handler on "${channel}" threw: ${msg}. See the console for details.`,
        6000,
      );
    });
  }, [toast]);

  return null;
}
