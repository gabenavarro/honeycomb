/** Problems panel (M10).
 *
 * Aggregates hub-surfaced issues (health-checker transitions, agent
 * unreachable events). New entries arrive live via the ``problems``
 * WebSocket channel so the panel stays in sync without polling. The
 * initial list comes from ``GET /api/problems`` on mount.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, AlertTriangle, Info, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";

import { clearProblems, listProblems } from "../lib/api";
import type { Problem, WSFrame } from "../lib/types";
import { useHiveWebSocket } from "../hooks/useWebSocket";
import { useToasts } from "../hooks/useToasts";

const SEVERITY_ORDER: Record<Problem["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function SeverityIcon({ severity }: { severity: Problem["severity"] }) {
  switch (severity) {
    case "error":
      return <AlertCircle size={12} className="text-red-400" />;
    case "warning":
      return <AlertTriangle size={12} className="text-yellow-400" />;
    case "info":
    default:
      return <Info size={12} className="text-blue-400" />;
  }
}

export function ProblemsPanel() {
  const { toast } = useToasts();
  const queryClient = useQueryClient();
  const { subscribe, unsubscribe, onChannel } = useHiveWebSocket();

  const { data, isLoading } = useQuery({
    queryKey: ["problems"],
    queryFn: listProblems,
  });

  useEffect(() => {
    subscribe(["problems"]);
    const off = onChannel("problems", (frame: WSFrame) => {
      if (frame.event !== "problem") return;
      const problem = frame.data as Problem;
      // Prepend new problems to whatever the server returned.
      queryClient.setQueryData<{ problems: Problem[] }>(["problems"], (old) => ({
        problems: [...(old?.problems ?? []), problem],
      }));
    });
    return () => {
      off();
      unsubscribe(["problems"]);
    };
  }, [subscribe, unsubscribe, onChannel, queryClient]);

  const sorted = useMemo(() => {
    const items = data?.problems ?? [];
    return [...items].sort((a, b) => {
      const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (s !== 0) return s;
      // Newest first within the same severity.
      return b.id - a.id;
    });
  }, [data]);

  const clear = useCallback(async () => {
    try {
      await clearProblems();
      queryClient.setQueryData(["problems"], { problems: [] });
      toast("success", "Problems cleared");
    } catch (err) {
      toast("error", "Clear failed", err instanceof Error ? err.message : String(err));
    }
  }, [queryClient, toast]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-[#2b2b2b] px-3 py-1.5">
        <h3 className="text-[10px] font-semibold tracking-wider text-[#858585] uppercase">
          Problems ({sorted.length})
        </h3>
        <button
          type="button"
          onClick={clear}
          disabled={sorted.length === 0}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#858585] hover:bg-[#2a2a2a] hover:text-[#c0c0c0] disabled:opacity-40"
          title="Clear all problems"
          aria-label="Clear all problems"
        >
          <Trash2 size={10} />
          Clear
        </button>
      </header>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="px-3 py-2 text-xs text-[#858585]">Loading…</p>}
        {!isLoading && sorted.length === 0 && (
          <p className="px-3 py-2 text-xs text-[#606060]">
            No problems. Health transitions and agent disconnects will appear here.
          </p>
        )}
        <ul className="divide-y divide-[#2b2b2b]/50">
          {sorted.map((p) => (
            <li key={p.id} className="flex items-start gap-2 px-3 py-2 text-xs">
              <SeverityIcon severity={p.severity} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[#e7e7e7]">{p.message}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[#858585]">
                  <span>{p.source}</span>
                  {p.project_name && <span>· {p.project_name}</span>}
                  <span>· {relativeTime(p.created_at)}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
