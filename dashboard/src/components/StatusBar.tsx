/** Bottom status bar — VSCode-style thin accent strip. */

import { useQuery } from "@tanstack/react-query";
import { Activity, Wifi, WifiOff, Cpu, GitBranch } from "lucide-react";
import { getHealth, listContainers } from "../lib/api";
import { useHiveWebSocket } from "../hooks/useWebSocket";
import { backoffRefetch } from "../hooks/useSmartPoll";
import { ResourcePill } from "./ResourcePill";

interface StatusBarProps {
  activeContainerId: number | null;
  activeContainerName: string | null;
}

export function StatusBar({ activeContainerId, activeContainerName }: StatusBarProps) {
  const { connected } = useHiveWebSocket();
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: backoffRefetch({ baseMs: 10_000, maxMs: 120_000 }),
  });
  const { data: containers = [] } = useQuery({
    queryKey: ["containers"],
    queryFn: listContainers,
    refetchInterval: backoffRefetch(),
  });

  const running = containers.filter((c) => c.container_status === "running").length;
  const gpuOwner = containers.find((c) => c.has_gpu && c.container_status === "running");

  return (
    <footer
      className="flex h-6 items-center justify-between gap-4 bg-[#0078d4] px-3 text-[10px] font-medium text-white"
      role="contentinfo"
    >
      <div className="flex items-center gap-3">
        {connected ? (
          <span className="flex items-center gap-1" title="Hub WebSocket connected">
            <Wifi size={10} /> hub
          </span>
        ) : (
          <span
            className="flex items-center gap-1 text-yellow-200"
            title="Hub WebSocket disconnected — reconnecting…"
          >
            <WifiOff size={10} /> reconnecting
          </span>
        )}
        <span className="flex items-center gap-1">
          <Activity size={10} /> v{health?.version ?? "?"}
        </span>
        <span className="flex items-center gap-1">
          <GitBranch size={10} /> {running}/{containers.length} running
        </span>
        {gpuOwner && (
          <span className="flex items-center gap-1" title="GPU owner">
            <Cpu size={10} /> GPU: {gpuOwner.project_name}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <ResourcePill containerId={activeContainerId} containerName={activeContainerName} />
        {activeContainerName && <span>{activeContainerName}</span>}
        <span className="opacity-75">Ctrl+K · Ctrl+B · Ctrl+` · Ctrl+W</span>
      </div>
    </footer>
  );
}
