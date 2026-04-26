/** Library route (M32 bridge).
 *
 * The full Library — eight artifact types, primary/More chips, scope
 * picker — arrives in M35. For M32 we surface the existing M27 Recent
 * Edits view as the bridge content.
 */
import { useEffect } from "react";

import { ContainerList } from "../ContainerList";
import { DiffEventsActivity } from "../DiffEventsActivity";
import { DiffViewerTab } from "../DiffViewerTab";
import { ErrorBoundary } from "../ErrorBoundary";
import type { ContainerRecord, DiffEvent } from "../../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
  openedDiffEvent: DiffEvent | null;
  onOpenEvent: (e: DiffEvent | null) => void;
}

export function LibraryRoute({
  containers,
  activeContainerId,
  onSelectContainer,
  openedDiffEvent,
  onOpenEvent,
}: Props) {
  useEffect(() => {
    onOpenEvent(null);
  }, [activeContainerId, onOpenEvent]);

  void containers;
  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside
        aria-label="Library sidebar"
        className="border-edge bg-pane flex w-72 shrink-0 flex-col border-r"
      >
        <header className="border-edge border-b px-3 py-1.5">
          <h2 className="text-secondary text-[10px] font-semibold tracking-wider uppercase">
            Library
          </h2>
        </header>
        <div className="flex-1 overflow-y-auto">
          <ContainerList selectedId={activeContainerId} onSelect={onSelectContainer} />
          {activeContainerId !== null && (
            <DiffEventsActivity containerId={activeContainerId} onOpenEvent={onOpenEvent} />
          )}
        </div>
      </aside>
      <main className="bg-page flex h-full min-w-0 flex-1 flex-col">
        {openedDiffEvent !== null ? (
          <ErrorBoundary
            key={`eb-diff-${openedDiffEvent.event_id}`}
            label={`the diff viewer for ${openedDiffEvent.path}`}
          >
            <DiffViewerTab event={openedDiffEvent} onOpenFile={() => undefined} />
          </ErrorBoundary>
        ) : (
          <LibraryEmptyState />
        )}
      </main>
    </div>
  );
}

function LibraryEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-secondary text-sm">
        Pick a container, then a recent edit, to view the diff here.
      </p>
      <p className="text-muted text-[11px]">
        The full Library (Plans / Reviews / Skills / Specs and more) arrives in M35.
      </p>
    </div>
  );
}
