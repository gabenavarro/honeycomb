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
import { useCallback, useEffect } from "react";

import {
  createNamedSession,
  deleteNamedSession,
  listNamedSessions,
  renameNamedSession,
  reorderNamedSession,
} from "../lib/api";
import type { NamedSession, NamedSessionCreate, SessionKind } from "../lib/types";
import { clearTurns as clearChatStreamTurns } from "./chatStreamStore";
import { useHiveWebSocket } from "./useWebSocket";

export interface UseSessionsResult {
  sessions: NamedSession[];
  isLoading: boolean;
  error: unknown;
  create: (input: NamedSessionCreate) => Promise<NamedSession>;
  rename: (sessionId: string, name: string) => Promise<void>;
  close: (sessionId: string) => Promise<void>;
  reorder: (sessionId: string, newPosition: number) => Promise<void>;
}

function provisional(containerId: number, name: string, kind: SessionKind): NamedSession {
  const now = new Date().toISOString();
  return {
    session_id: `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    container_id: containerId,
    name,
    kind,
    // M28 — provisional rows slot at the end; the server's renumber
    // on first refetch corrects to the canonical position.
    position: 0,
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

  const ws = useHiveWebSocket();

  // M30 — WebSocket push: every hub-side CRUD commit broadcasts a
  // ``list`` frame with the full NamedSession[] for the container.
  // We replace the cache wholesale; TanStack Query's 30s staleTime
  // + refetchOnWindowFocus stay as the fallback for events missed
  // during a reconnect gap.
  useEffect(() => {
    if (containerId === null) return;
    const channel = `sessions:${containerId}`;
    ws.subscribe([channel]);
    const removeListener = ws.onChannel(channel, (frame) => {
      if (frame.event !== "list") return;
      const next = frame.data as NamedSession[];
      qc.setQueryData<NamedSession[]>(queryKey, next);
    });
    return () => {
      removeListener();
      ws.unsubscribe([channel]);
    };
    // queryKey is derived from containerId; ws is a stable singleton
    // wrapper. Including them would just re-trigger the effect on
    // every render without changing behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, ws, qc]);

  const createMutation = useMutation({
    mutationFn: (input: NamedSessionCreate) => createNamedSession(containerId as number, input),
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
    onSuccess: (_data, sessionId) => {
      // Evict the chat-stream store entry once the server confirms the
      // session is gone — without this the in-memory turns array would
      // pin every transcript for the page lifetime (M37 follow-up).
      clearChatStreamTurns(sessionId);
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) qc.setQueryData(queryKey, ctx.previous);
    },
  });

  const reorderMutation = useMutation({
    mutationFn: ({ sessionId, position }: { sessionId: string; position: number }) =>
      reorderNamedSession(sessionId, position),
    onMutate: async ({ sessionId, position }) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<NamedSession[]>(queryKey) ?? [];
      const moved = previous.find((s) => s.session_id === sessionId);
      if (!moved) return { previous };
      const without = previous.filter((s) => s.session_id !== sessionId);
      const target = Math.max(1, Math.min(position, without.length + 1));
      without.splice(target - 1, 0, moved);
      const renumbered = without.map((s, i) => ({ ...s, position: i + 1 }));
      qc.setQueryData<NamedSession[]>(queryKey, renumbered);
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

  const reorder = useCallback(
    async (sessionId: string, newPosition: number) => {
      await reorderMutation.mutateAsync({ sessionId, position: newPosition });
    },
    [reorderMutation],
  );

  return {
    sessions: query.data ?? [],
    isLoading: query.isFetching,
    error: query.error,
    create,
    rename,
    close,
    reorder,
  };
}
