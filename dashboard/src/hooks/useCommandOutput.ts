/** Subscribe to real-time command output streamed over WebSocket channel
 * `cmd:{command_id}`. Frames carry `{command_id, stream, text, ts}` per line
 * (see hub/main.py receive_event).
 */

import { useEffect, useRef } from "react";
import type { WSFrame } from "../lib/types";
import { useHiveWebSocket } from "./useWebSocket";

export interface CommandOutputFrame {
  command_id: string;
  stream: "stdout" | "stderr" | "exit";
  text: string;
  ts: string;
}

type Handler = (frame: CommandOutputFrame) => void;

/**
 * Hook that delivers command output frames to a handler as they arrive.
 * Subscribes on mount, unsubscribes on command completion or unmount.
 * `commandId` may be null — when it flips to a string, subscription begins.
 */
export function useCommandOutput(commandId: string | null, handler: Handler): void {
  const { subscribe, unsubscribe, onChannel } = useHiveWebSocket();
  // Keep latest handler in a ref so the subscription effect doesn't re-run
  // every render; handler is invoked via the ref.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!commandId) return;
    const channel = `cmd:${commandId}`;
    subscribe([channel]);
    const off = onChannel(channel, (frame: WSFrame) => {
      const data = frame.data as CommandOutputFrame;
      if (!data?.command_id) return;
      handlerRef.current(data);
    });
    return () => {
      off();
      unsubscribe([channel]);
    };
  }, [commandId, onChannel, subscribe, unsubscribe]);
}
