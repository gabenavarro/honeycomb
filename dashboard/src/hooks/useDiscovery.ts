/** Query-backed discovery of unregistered workspaces and containers.
 *
 * De-duplication: when a running container's inferred workspace_folder
 * matches a workspace candidate, the container wins — it's the stronger
 * signal (the thing is actually running) and registering from the
 * container path also links the Docker container ID.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { discoverAll } from "../lib/api";
import type { ContainerCandidate, WorkspaceCandidate } from "../lib/types";
import { backoffRefetch } from "./useSmartPoll";

export interface DiscoveryResult {
  containers: ContainerCandidate[];
  workspaces: WorkspaceCandidate[];
  discoverRoots: string[];
  totalCandidates: number;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  lastUpdated: number;
  refetch: () => void;
}

export function useDiscovery(): DiscoveryResult {
  const query = useQuery({
    queryKey: ["discover"],
    queryFn: discoverAll,
    refetchInterval: backoffRefetch({ baseMs: 15_000, maxMs: 120_000 }),
  });

  const deduped = useMemo(() => {
    const containers = query.data?.containers ?? [];
    const workspaces = query.data?.workspaces ?? [];
    const containerFolders = new Set(
      containers.map((c) => c.inferred_workspace_folder).filter((x): x is string => Boolean(x)),
    );
    const filteredWorkspaces = workspaces.filter((w) => !containerFolders.has(w.workspace_folder));
    return { containers, workspaces: filteredWorkspaces };
  }, [query.data]);

  return {
    containers: deduped.containers,
    workspaces: deduped.workspaces,
    discoverRoots: query.data?.discover_roots ?? [],
    totalCandidates: deduped.containers.length + deduped.workspaces.length,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: (query.error as Error | null) ?? null,
    lastUpdated: query.dataUpdatedAt,
    refetch: () => {
      void query.refetch();
    },
  };
}
