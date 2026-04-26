/** WorkspacePill (M32).
 *
 * A small button rendered at the top of the Chats route's main pane.
 * Shows the active workspace's project name + a chevron. Click opens
 * a Radix Popover containing WorkspacePicker; selecting a row in the
 * picker closes the popover and swaps the active workspace.
 *
 * In M33 the chat-thread chrome will host this pill directly. For
 * the M32 bridge it lives in ChatsRoute's header above the existing
 * Breadcrumbs / SessionSubTabs strip.
 */
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { WorkspacePicker } from "./WorkspacePicker";
import type { ContainerRecord } from "../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function WorkspacePill({ containers, activeContainerId, onSelectContainer }: Props) {
  const [open, setOpen] = useState(false);
  const active = containers.find((c) => c.id === activeContainerId) ?? null;
  const label = active?.project_name ?? "No workspace";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2 border-b border-edge bg-pane px-3 py-1.5">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={active === null ? "No workspace selected" : label}
            className="flex max-w-[18rem] items-center gap-1.5 rounded border border-edge bg-chip px-2 py-1 text-[12px] text-primary transition-colors hover:bg-pane focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="truncate">{label}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </Popover.Trigger>
      </div>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-80 overflow-hidden rounded border border-edge bg-pane shadow-medium"
        >
          <WorkspacePicker
            containers={containers}
            activeContainerId={activeContainerId}
            onSelect={(id) => {
              onSelectContainer(id);
              setOpen(false);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
