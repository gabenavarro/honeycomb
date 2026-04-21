/** Persistent named sessions for a container (M26).
 *
 * Replaces the pre-M26 localStorage-backed session registry. The
 * hub owns the truth; reloads and new devices pull the same list.
 *
 * Mutations are optimistic: ``create`` appends a pending row, then
 * swaps in the server-assigned ``session_id`` once the POST
 * resolves. ``rename`` and ``close`` patch the cache immediately
 * and roll back on error.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  createNamedSession,
  deleteNamedSession,
  listNamedSessions,
  renameNamedSession,
} from "../lib/api";
import type { NamedSession, NamedSessionCreate, SessionKind } from "../lib/types";

export interface UseSessionsResult {
  sessions: NamedSession[];
  isLoading: boolean;
  error: unknown;
  create: (input: NamedSessionCreate) => Promise<NamedSession>;
  rename: (sessionId: string, name: string) => Promise<void>;
  close: (sessionId: string) => Promise<void>;
}

function provisional(containerId: number, name: string, kind: SessionKind): NamedSession {
  const now = new Date().toISOString();
  return {
    session_id: `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    container_id: containerId,
    name,
    kind,
    created_at: now,
    updated_at: now,
  };
}

export function useSessions(containerId: number | null): UseSessionsResult {
  const qc = useQueryClient();
  const queryKey = ["named-sessions", containerId] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => listNamedSessions(containerId as number),
    enabled: containerId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const createMutation = useMutation({
    mutationFn: (input: NamedSessionCreate) =>
      createNamedSession(containerId as number, input),
    onMutate: async (input) => {
      if (containerId === null) return { previous: [] as NamedSession[], pending: null };
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<NamedSession[]>(queryKey) ?? [];
      const pending = provisional(containerId, input.name, input.kind ?? "shell");
      qc.setQueryData<NamedSession[]>(queryKey, [...previous, pending]);
      return { previous, pending };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) qc.setQueryData(queryKey, ctx.previous);
    },
    onSuccess: (server, _vars, ctx) => {
      // Swap the pending row for the server row. If no pending row
      // (containerId was null), just append.
      qc.setQueryData<NamedSession[]>(queryKey, (prev) => {
        const base = prev ?? [];
        if (ctx?.pending) {
          return base.map((s) => (s.session_id === ctx.pending!.session_id ? server : s));
        }
        return [...base, server];
      });
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ sessionId, name }: { sessionId: string; name: string }) =>
      renameNamedSession(sessionId, name),
    onMutate: async ({ sessionId, name }) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<NamedSession[]>(queryKey) ?? [];
      qc.setQueryData<NamedSession[]>(
        queryKey,
        previous.map((s) => (s.session_id === sessionId ? { ...s, name } : s)),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) qc.setQueryData(queryKey, ctx.previous);
    },
  });

  const closeMutation = useMutation({
    mutationFn: (sessionId: string) => deleteNamedSession(sessionId),
    onMutate: async (sessionId) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<NamedSession[]>(queryKey) ?? [];
      qc.setQueryData<NamedSession[]>(
        queryKey,
        previous.filter((s) => s.session_id !== sessionId),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) qc.setQueryData(queryKey, ctx.previous);
    },
  });

  const create = useCallback(
    (input: NamedSessionCreate) => createMutation.mutateAsync(input),
    [createMutation],
  );
  const rename = useCallback(
    async (sessionId: string, name: string) => {
      await renameMutation.mutateAsync({ sessionId, name });
    },
    [renameMutation],
  );
  const close = useCallback(
    async (sessionId: string) => {
      await closeMutation.mutateAsync(sessionId);
    },
    [closeMutation],
  );

  return {
    sessions: query.data ?? [],
    isLoading: query.isFetching,
    error: query.error,
    create,
    rename,
    close,
  };
}
