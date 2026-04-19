/** File-index for the command palette's ``file:`` mode (M23).
 *
 * Wraps ``GET /api/containers/{id}/fs/walk`` via React Query so re-
 * opening the palette within a 30s window hits the cache instead of
 * re-walking. Gated on ``enabled`` — only the palette in file mode
 * currently asks for this, so every other consumer stays free of the
 * fetch.
 *
 * Returns ``entries`` empty when disabled, loading, or errored so
 * callers can render unconditionally without defensive checks.
 */

import { useQuery } from "@tanstack/react-query";

import { listContainerFiles } from "../lib/api";
import type { FsEntry } from "../lib/types";

interface UseContainerFileIndexOptions {
  enabled?: boolean;
}

export interface UseContainerFileIndexResult {
  entries: FsEntry[];
  truncated: boolean;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

export function useContainerFileIndex(
  containerId: number | null,
  { enabled = true }: UseContainerFileIndexOptions = {},
): UseContainerFileIndexResult {
  const effective = enabled && containerId !== null;
  const query = useQuery({
    queryKey: ["fs:walk", containerId],
    queryFn: () => listContainerFiles(containerId as number),
    enabled: effective,
    staleTime: 30_000,
    gcTime: 120_000,
    refetchOnWindowFocus: false,
  });

  return {
    entries: query.data?.entries ?? [],
    truncated: query.data?.truncated ?? false,
    isLoading: query.isFetching,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
