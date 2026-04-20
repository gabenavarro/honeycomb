/** Resource-sample history for the active container (M25).
 *
 * On mount: fetches ``GET /resources/history`` once to hydrate the
 * last 5 minutes of samples from the hub's ring buffer — so a
 * reload, or a new device opening the dashboard over Tailscale,
 * shows the same 5-minute window the last session saw.
 *
 * While live: subscribes to the existing ``/resources`` React Query
 * cache that ``ResourcePill`` / ``ResourceMonitor`` already drive on
 * a 5s poll. Each new sample appends to an in-memory buffer; the
 * 61st entry drops the oldest.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getResourceHistory, getResources } from "../lib/api";
import type { ResourceStats } from "../lib/types";

const HISTORY_CAP = 60;

export function useResourceHistory(
  containerId: number | null,
): ResourceStats[] {
  const { data: seed } = useQuery({
    queryKey: ["resources:history", containerId],
    queryFn: () => getResourceHistory(containerId as number),
    enabled: containerId !== null,
    staleTime: Infinity, // One-shot hydration.
    refetchOnWindowFocus: false,
  });

  const { data: live } = useQuery({
    queryKey: ["resources", containerId],
    queryFn: () => getResources(containerId as number),
    enabled: containerId !== null,
    refetchInterval: 5_000,
  });

  const [buffer, setBuffer] = useState<ResourceStats[]>([]);

  // Reseed from history whenever a new seed arrives.
  useEffect(() => {
    if (seed) setBuffer(seed);
  }, [seed]);

  // Append each live tick, dedup the hydration/first-tick overlap,
  // and drop the oldest at 61 entries.
  useEffect(() => {
    if (!live) return;
    setBuffer((prev) => {
      if (
        prev.length > 0 &&
        prev[prev.length - 1].timestamp === live.timestamp
      ) {
        return prev;
      }
      const next = [...prev, live];
      return next.length > HISTORY_CAP
        ? next.slice(next.length - HISTORY_CAP)
        : next;
    });
  }, [live]);

  // Clear the buffer when containerId becomes null.
  useEffect(() => {
    if (containerId === null) setBuffer([]);
  }, [containerId]);

  return buffer;
}
