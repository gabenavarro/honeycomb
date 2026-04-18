/** Bottom status bar — VSCode-style thin accent strip.
 *
 * M21 I: hub connectivity now lives in a single ``ConnectivityChip``
 * that replaces the old WiFi + version + "reconnecting" text. Clicking
 * the chip opens a popover with a per-signal breakdown (WS, REST,
 * active PTY). Frees up a few inches of horizontal room and surfaces
 * the "is the dashboard actually talking to the hub?" question as a
 * single discoverable UI.
 */

import { useQuery } from "@tanstack/react-query";
import { Cpu, GitBranch } from "lucide-react";

import { listContainers } from "../lib/api";
import { backoffRefetch } from "../hooks/useSmartPoll";
import { ConnectivityChip } from "./ConnectivityChip";
import { NotificationCenter } from "./NotificationCenter";
import { ResourcePill } from "./ResourcePill";

interface StatusBarProps {
  activeContainerId: number | null;
  activeContainerName: string | null;
}

export function StatusBar({ activeContainerId, activeContainerName }: StatusBarProps) {
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
        <ConnectivityChip activeContainerId={activeContainerId} />
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
        <NotificationCenter />
        {activeContainerName && <span>{activeContainerName}</span>}
        <span className="opacity-75">Ctrl+K · Ctrl+B · ?</span>
      </div>
    </footer>
  );
}
