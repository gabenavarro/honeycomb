/** useArtifacts — TanStack Query fetch + WebSocket push for
 *  library:<container_id> (M35). Pattern mirrors M30 useDiffEvents.
 *
 *  The `library:<id>` channel delivers three event types:
 *    - `new`     — incoming artifact prepended to the TanStack cache.
 *    - `deleted` — artifact removed from the cache by artifact_id.
 *    - `updated` — full refetch via invalidateQueries (cheaper than
 *                  reconciling partial patches for pinned/archived state).
 *
 *  30 s staleTime + refetchOnWindowFocus act as the safety net for events
 *  missed during a reconnect gap. All three paths keep the TanStack cache
 *  as the single source of truth — no shadow useState store.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { listArtifacts } from "../lib/api";
import type { Artifact, ListArtifactsParams } from "../lib/types";
import { useHiveWebSocket } from "./useWebSocket";

export interface UseArtifactsResult {
  artifacts: Artifact[];
  isLoading: boolean;
  error: unknown;
}

export function useArtifacts(
  containerId: number | null,
  params: ListArtifactsParams,
): UseArtifactsResult {
  const qc = useQueryClient();
  const ws = useHiveWebSocket();
  const queryKey =
    containerId !== null
      ? (["artifacts", containerId, params] as const)
      : (["artifacts", "_disabled"] as const);

  const query = useQuery({
    queryKey,
    queryFn: () => listArtifacts(containerId as number, params),
    enabled: containerId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // M35 — WS push: artifact events broadcast on library:<id>.
  // 'new' prepends to the cache, 'deleted' filters by artifact_id,
  // 'updated' invalidates so TanStack refetches pinned/archived state.
  // 30s staleTime + refetchOnWindowFocus remain as a fallback for
  // events missed during a reconnect gap.
  useEffect(() => {
    if (containerId === null) return;
    const channel = `library:${containerId}`;
    ws.subscribe([channel]);
    const removeListener = ws.onChannel(channel, (frame) => {
      if (frame.event === "new") {
        const incoming = frame.data as Artifact;
        qc.setQueryData<Artifact[]>(queryKey, (prev) => [incoming, ...(prev ?? [])]);
      } else if (frame.event === "deleted") {
        const { artifact_id } = frame.data as { artifact_id: string };
        qc.setQueryData<Artifact[]>(queryKey, (prev) =>
          (prev ?? []).filter((a) => a.artifact_id !== artifact_id),
        );
      } else if (frame.event === "updated") {
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
    artifacts: query.data ?? [],
    isLoading: query.isFetching,
    error: query.error,
  };
}
