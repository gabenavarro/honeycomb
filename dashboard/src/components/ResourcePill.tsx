/** Compact resource indicator for the StatusBar (M13).
 *
 * Replaces the always-visible right-hand ResourceMonitor aside. A tiny
 * pill displays CPU / memory / GPU headline numbers for the focused
 * container; clicking it opens a Radix Popover with the full
 * ResourceMonitor bar chart. When no container is focused, or the
 * resources endpoint hasn't answered yet, the pill renders empty so
 * the StatusBar doesn't jump between widths.
 */

import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import { Cpu, MonitorDot } from "lucide-react";

import { getResources } from "../lib/api";
import { ResourceMonitor } from "./ResourceMonitor";

interface Props {
  containerId: number | null;
  containerName: string | null;
}

export function ResourcePill({ containerId, containerName }: Props) {
  const { data: stats } = useQuery({
    queryKey: ["resources", containerId],
    queryFn: () => (containerId === null ? Promise.resolve(null) : getResources(containerId)),
    enabled: containerId !== null,
    // Same cadence as the original panel so the headline numbers match
    // whatever the popover shows when it opens.
    refetchInterval: 5000,
  });

  if (containerId === null) {
    return null;
  }

  const cpu = stats?.cpu_percent ?? 0;
  const memPct = stats?.memory_percent ?? 0;
  const gpu = stats?.gpu_utilization ?? null;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded px-1.5 py-0.5 text-[10px] text-white/90 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
          title={
            stats
              ? `Click for full resource view — ${containerName ?? "this container"}`
              : "Resources loading…"
          }
          aria-label="Show resource details"
        >
          <span className="flex items-center gap-1">
            <Cpu size={10} aria-hidden="true" />
            {cpu.toFixed(0)}%
          </span>
          <span aria-hidden="true" className="opacity-60">
            ·
          </span>
          <span>MEM {memPct.toFixed(0)}%</span>
          {gpu !== null && (
            <>
              <span aria-hidden="true" className="opacity-60">
                ·
              </span>
              <span className="flex items-center gap-1">
                <MonitorDot size={10} aria-hidden="true" />
                {gpu.toFixed(0)}%
              </span>
            </>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          className="z-50 w-72 rounded-md border border-[#2b2b2b] bg-[#1e1e1e] p-0 text-[#cccccc] shadow-xl outline-none"
        >
          <div className="p-2">
            <ResourceMonitor containerId={containerId} />
          </div>
          <Popover.Arrow className="fill-[#2b2b2b]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
