/** Editor-area container tabs — VSCode-style, one tab per opened container.
 * Click to focus, middle-click or × to close (just removes from the open
 * set — the container itself stays registered). */

import { X } from "lucide-react";
import { AgentStatusBadge, ContainerStatusBadge, GpuBadge } from "./StatusBadge";
import type { ContainerRecord } from "../lib/types";

interface Props {
  openContainers: ContainerRecord[];
  activeId: number | null;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
}

export function ContainerTabs({
  openContainers,
  activeId,
  onFocus,
  onClose,
}: Props) {
  if (openContainers.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Open containers"
      className="flex shrink-0 items-center gap-0 border-b border-[#2b2b2b] bg-[#252526] overflow-x-auto"
    >
      {openContainers.map((c) => {
        const active = c.id === activeId;
        return (
          <div
            key={c.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => onFocus(c.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onFocus(c.id);
              }
            }}
            onAuxClick={(e) => {
              // Middle-click closes the tab, VSCode-style.
              if (e.button === 1) {
                e.preventDefault();
                onClose(c.id);
              }
            }}
            className={`group flex shrink-0 cursor-pointer items-center gap-2 border-r border-[#2b2b2b] px-3 py-1.5 text-xs transition-colors ${
              active
                ? "bg-[#1e1e1e] text-[#e7e7e7] border-t-2 border-t-[#0078d4]"
                : "bg-[#2d2d2d] text-[#969696] hover:bg-[#353535]"
            }`}
          >
            <span className="truncate max-w-[180px]">{c.project_name}</span>
            {c.has_gpu && <GpuBadge />}
            <ContainerStatusBadge status={c.container_status} />
            <AgentStatusBadge status={c.agent_status} />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(c.id);
              }}
              className="rounded p-0.5 opacity-40 hover:bg-[#444] hover:opacity-100"
              aria-label={`Close ${c.project_name} tab`}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
