import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Square, Trash2, RefreshCw } from "lucide-react";
import { listContainers, startContainer, stopContainer, deleteContainer } from "../lib/api";
import type { ContainerRecord } from "../lib/types";
import { AgentStatusBadge, ContainerStatusBadge, GpuBadge } from "./StatusBadge";
import { backoffRefetch } from "../hooks/useSmartPoll";

interface Props {
  selectedId: number | null;
  onSelect: (id: number) => void;
}

const typeLabels: Record<string, string> = {
  base: "Base",
  "ml-cuda": "ML/CUDA",
  "web-dev": "Web Dev",
  compbio: "CompBio",
};

export function ContainerList({ selectedId, onSelect }: Props) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["containers"],
    queryFn: listContainers,
    refetchInterval: backoffRefetch(),
  });
  const { data: containers = [], isLoading, dataUpdatedAt, isFetching } = query;

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["containers"] });
  }, [queryClient]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (containers.length === 0) return;
      const currentIdx = containers.findIndex((c) => c.id === selectedId);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = containers[Math.min(containers.length - 1, currentIdx + 1)];
        if (next) onSelect(next.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = containers[Math.max(0, currentIdx - 1)];
        if (prev) onSelect(prev.id);
      }
    },
    [containers, selectedId, onSelect],
  );

  const startMut = useMutation({
    mutationFn: startContainer,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["containers"] }),
  });

  const stopMut = useMutation({
    mutationFn: stopContainer,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["containers"] }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => deleteContainer(id, true),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["containers"] }),
  });

  if (isLoading) {
    return <div className="p-4 text-sm text-gray-500">Loading containers...</div>;
  }

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour12: false })
    : "";

  if (containers.length === 0) {
    return (
      <div className="p-4 text-sm text-gray-500">
        <div className="flex items-center justify-between">
          <span>No containers registered.</span>
          <RefreshButton onClick={refresh} spinning={isFetching} />
        </div>
        <p className="mt-2 text-xs text-gray-600">Use the provisioning wizard to create one.</p>
      </div>
    );
  }

  return (
    <div
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="listbox"
      aria-label="Containers"
      className="outline-none"
    >
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-1.5 text-[10px] text-gray-600">
        <span>
          {containers.length} container{containers.length === 1 ? "" : "s"} · {lastUpdated}
        </span>
        <RefreshButton onClick={refresh} spinning={isFetching} />
      </div>
      <ul className="divide-y divide-gray-800">
        {containers.map((c: ContainerRecord, idx: number) => (
          <li
            key={c.id}
            role="option"
            aria-selected={selectedId === c.id}
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(c.id);
              }
            }}
            className={`cursor-pointer px-3 py-2.5 transition-colors hover:bg-gray-800/50 ${
              selectedId === c.id ? "border-l-2 border-blue-500 bg-gray-800" : ""
            }`}
            onClick={() => onSelect(c.id)}
            data-idx={idx}
          >
            <div className="flex items-center justify-between">
              <span className="truncate text-sm font-medium text-gray-200">{c.project_name}</span>
              <div className="flex items-center gap-1">
                {c.has_gpu && <GpuBadge />}
                <span className="rounded bg-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">
                  {typeLabels[c.project_type] ?? c.project_type}
                </span>
              </div>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <div className="flex gap-3">
                <ContainerStatusBadge status={c.container_status} />
                <AgentStatusBadge status={c.agent_status} />
              </div>
              <div className="flex gap-1">
                {c.container_status === "stopped" ? (
                  <button
                    className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-green-400"
                    title="Start"
                    onClick={(e) => {
                      e.stopPropagation();
                      startMut.mutate(c.id);
                    }}
                  >
                    <Play size={12} />
                  </button>
                ) : c.container_status === "running" ? (
                  <button
                    className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-yellow-400"
                    title="Stop"
                    onClick={(e) => {
                      e.stopPropagation();
                      stopMut.mutate(c.id);
                    }}
                  >
                    <Square size={12} />
                  </button>
                ) : null}
                <button
                  className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-red-400"
                  title="Remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteMut.mutate(c.id);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            <p className="mt-1 truncate text-[11px] text-gray-600">{c.workspace_folder}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RefreshButton({ onClick, spinning }: { onClick: () => void; spinning: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-gray-300"
      aria-label="Refresh container list"
      title="Refresh"
    >
      <RefreshCw size={12} className={spinning ? "animate-spin" : undefined} />
    </button>
  );
}
