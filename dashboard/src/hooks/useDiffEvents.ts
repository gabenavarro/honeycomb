import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { listDiffEvents } from "../lib/api";
import type { DiffEvent } from "../lib/types";
import { useHiveWebSocket } from "./useWebSocket";

export const DIFF_EVENT_CACHE_CAP = 200;

export interface UseDiffEventsResult {
  events: DiffEvent[];
  isLoading: boolean;
  error: unknown;
}

export function useDiffEvents(containerId: number | null): UseDiffEventsResult {
  const qc = useQueryClient();
  const queryKey = ["diff-events", containerId] as const;
  const ws = useHiveWebSocket();

  const query = useQuery({
    queryKey,
    queryFn: () => listDiffEvents(containerId as number),
    enabled: containerId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // M27 — WS push: every recorded diff event broadcasts on
  // diff-events:<id>. Listener prepends to the cache.
  // 30s staleTime + refetchOnWindowFocus stay as the fallback for
  // events missed during a reconnect gap.
  useEffect(() => {
    if (containerId === null) return;
    const channel = `diff-events:${containerId}`;
    ws.subscribe([channel]);
    const removeListener = ws.onChannel(channel, (frame) => {
      if (frame.event !== "new") return;
      const incoming = frame.data as DiffEvent;
      qc.setQueryData<DiffEvent[]>(queryKey, (prev) => {
        const base = prev ?? [];
        const next = [incoming, ...base];
        return next.length > DIFF_EVENT_CACHE_CAP
          ? next.slice(0, DIFF_EVENT_CACHE_CAP)
          : next;
      });
    });
    return () => {
      removeListener();
      ws.unsubscribe([channel]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, ws, qc]);

  return {
    events: query.data ?? [],
    isLoading: query.isFetching,
    error: query.error,
  };
}
