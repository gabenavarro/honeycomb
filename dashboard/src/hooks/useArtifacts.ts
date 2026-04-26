/** useArtifacts — TanStack Query fetch + WebSocket push for
 *  library:<container_id> (M35). Pattern mirrors M30 useDiffEvents.
 *
 *  The `library:<id>` channel delivers three event types:
 *    - `new`     — incoming artifact prepended to the local list.
 *    - `deleted` — artifact removed from the local list by artifact_id.
 *    - `updated` — full refetch via TanStack (cheaper than reconciling
 *                  partial patches for pinned/archived state changes).
 *
 *  'new' and 'deleted' update local React state directly so they respond
 *  synchronously within act() in tests and on the same React tick in
 *  production. 'updated' invalidates the TanStack cache so a refetch
 *  picks up pinned/archived state changes from the server.
 *
 *  The return value merges both sources: localList (WS-driven) takes
 *  priority over query.data (REST-driven) via `??`. Once localList is set
 *  (non-null), it is the source of truth until the container changes.
 *
 *  30 s staleTime + refetchOnWindowFocus act as a safety net for events
 *  missed during a reconnect gap.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { listArtifacts } from "../lib/api";
import type { Artifact, ListArtifactsParams } from "../lib/types";
import { useHiveWebSocket } from "./useWebSocket";

export interface UseArtifactsResult {
  artifacts: Artifact[];
  isLoading: boolean;
  error: unknown;
}

const DISABLED_KEY = ["artifacts", "_disabled"] as const;

export function useArtifacts(
  containerId: number | null,
  params: ListArtifactsParams,
): UseArtifactsResult {
  const qc = useQueryClient();
  const ws = useHiveWebSocket();

  // localList holds WS-driven incremental mutations ('new', 'deleted').
  // It is null until the first WS event, at which point it becomes the
  // source of truth instead of query.data. This avoids the race where a
  // TanStack re-render (delayed via setTimeout by the notifyManager)
  // overwrites a WS-prepended item.
  const [localList, setLocalList] = useState<Artifact[] | null>(null);

  const queryKey = containerId !== null ? ["artifacts", containerId, params] : DISABLED_KEY;

  const query = useQuery({
    queryKey,
    queryFn: () => listArtifacts(containerId as number, params),
    enabled: containerId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // Reset local state when the container changes so stale items are never
  // shown for a freshly-selected container.
  useEffect(() => {
    setLocalList(null);
  }, [containerId]);

  // M35 — WS push: artifact events broadcast on library:<id>.
  // 'new' and 'deleted' update local state directly for synchronous
  // re-renders. 'updated' invalidates the TanStack cache so the next
  // render triggers a full refetch (cheaper than reconciling partial
  // patches for pinned/archived state changes).
  // 30s staleTime + refetchOnWindowFocus remain as a fallback for
  // events missed during a reconnect gap.
  useEffect(() => {
    if (containerId === null) return;
    const channel = `library:${containerId}`;
    ws.subscribe([channel]);
    const removeListener = ws.onChannel(channel, (frame) => {
      if (frame.event === "new") {
        const incoming = frame.data as Artifact;
        setLocalList((prev) => {
          const base = prev ?? query.data ?? [];
          return [incoming, ...base];
        });
      } else if (frame.event === "deleted") {
        const { artifact_id } = frame.data as { artifact_id: string };
        setLocalList((prev) => {
          const base = prev ?? query.data ?? [];
          return base.filter((a) => a.artifact_id !== artifact_id);
        });
      } else if (frame.event === "updated") {
        // Easier than reconciling partial updates: invalidate the cache so
        // TanStack refetches. The updated query.data will surface via the
        // return value's `localList ?? query.data` fallback once localList
        // is reset to null (e.g. on the next container switch), or directly
        // when localList is null.
        setLocalList(null);
        void qc.invalidateQueries({ queryKey });
      }
    });
    return () => {
      removeListener();
      ws.unsubscribe([channel]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, ws, qc]);

  return {
    artifacts: localList ?? query.data ?? [],
    isLoading: query.isFetching,
    error: query.error,
  };
}
