/** Editor-area container tabs — Radix Tabs since M8.
 *
 * Radix gives us keyboard navigation for free: Left/Right arrows move
 * between triggers, Home/End jump to first/last, and focus management
 * is WAI-ARIA compliant. Middle-click-to-close and the explicit ``×``
 * button both stay.
 *
 * We don't render ``Tabs.Content`` panels here because the editor
 * pane is managed separately (``TerminalPane`` in App.tsx). The Root
 * is just the focus ring + orientation for the list; ``aria-controls``
 * is therefore absent by design, and Radix's runtime warning about
 * missing content is silenced with ``activationMode="manual"``.
 */

import * as Tabs from "@radix-ui/react-tabs";
import { X } from "lucide-react";

import { clearAttention, useContainerAttention } from "../hooks/useAttention";
import type { ContainerRecord } from "../lib/types";
import { AgentStatusDot, ContainerStatusDot, GpuBadge, NeedsAttentionIcon } from "./StatusBadge";

interface Props {
  openContainers: ContainerRecord[];
  activeId: number | null;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
}

export function ContainerTabs({ openContainers, activeId, onFocus, onClose }: Props) {
  if (openContainers.length === 0) return null;

  return (
    <Tabs.Root
      value={activeId === null ? undefined : String(activeId)}
      onValueChange={(v) => {
        const id = Number(v);
        onFocus(id);
        // Focusing a tab clears its attention flag — the user has
        // acknowledged whatever was asking for input.
        clearAttention(id);
      }}
      activationMode="manual"
    >
      <Tabs.List
        aria-label="Open containers"
        className="flex shrink-0 items-center gap-0 overflow-x-auto border-b border-[#2b2b2b] bg-[#252526]"
      >
        {openContainers.map((c) => (
          <ContainerTab key={c.id} container={c} active={c.id === activeId} onClose={onClose} />
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}

function ContainerTab({
  container,
  active,
  onClose,
}: {
  container: ContainerRecord;
  active: boolean;
  onClose: (id: number) => void;
}) {
  const needsAttention = useContainerAttention(container.id);
  return (
    <Tabs.Trigger
      value={String(container.id)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(container.id);
        }
      }}
      className={`group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-[#2b2b2b] px-3 py-1.5 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0078d4] focus-visible:ring-inset ${
        active
          ? "border-t-2 border-t-[#0078d4] bg-[#1e1e1e] text-[#e7e7e7]"
          : "bg-[#2d2d2d] text-[#969696] hover:bg-[#353535]"
      }`}
    >
      {needsAttention && <NeedsAttentionIcon />}
      <span className="max-w-[180px] truncate">{container.project_name}</span>
      {container.has_gpu && <GpuBadge />}
      <ContainerStatusDot status={container.container_status} />
      <AgentStatusDot status={container.agent_status} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose(container.id);
        }}
        className="ml-0.5 rounded p-0.5 opacity-40 hover:bg-[#444] hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0078d4]"
        aria-label={`Close ${container.project_name} tab`}
      >
        <X size={11} aria-hidden="true" />
      </button>
    </Tabs.Trigger>
  );
}
