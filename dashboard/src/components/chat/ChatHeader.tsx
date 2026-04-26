/** Chat thread header — workspace pill (left) + mode + model + actions (right). */
import { Compass, History, MoreHorizontal } from "lucide-react";

import { WorkspacePill } from "../WorkspacePill";
import type { ContainerRecord } from "../../lib/types";
import { ModeToggle } from "./ModeToggle";
import { ModelChip } from "./ModelChip";

interface Props {
  sessionId: string;
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function ChatHeader({
  sessionId,
  containers,
  activeContainerId,
  onSelectContainer,
}: Props) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-edge bg-pane px-3 py-1.5">
      <WorkspacePill
        containers={containers}
        activeContainerId={activeContainerId}
        onSelectContainer={onSelectContainer}
      />
      <div className="flex items-center gap-2">
        <ModeToggle sessionId={sessionId} />
        <ModelChip sessionId={sessionId} />
        <button
          type="button"
          title="History (M35)"
          aria-label="Chat history"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <History size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          title="Compact context"
          aria-label="Compact context"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <Compass size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="More actions"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
