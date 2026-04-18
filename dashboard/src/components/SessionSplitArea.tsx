/** Terminal area with in-container session splits (M22.4).
 *
 * When the user drags a session tab from ``SessionSubTabs`` onto the
 * editor area, a drop overlay appears. Dropping sets that session as
 * the split pane next to the primary; closing the secondary pane
 * clears the split.
 *
 * Split state is owned by ``App.tsx`` (one session id per container)
 * and passed in via ``splitSessionId`` + ``onSetSplit`` / ``onClearSplit``.
 * We only react to the ``text/x-hive-session-split`` MIME so the
 * existing intra-strip reorder drop target keeps working unchanged.
 */

import { X } from "lucide-react";
import { useEffect, useState, type DragEvent } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { ErrorBoundary } from "./ErrorBoundary";
import { TerminalPane } from "./TerminalPane";
import type { SessionInfo } from "./SessionSubTabs";

interface Props {
  containerId: number;
  containerName: string;
  hasClaudeCli: boolean;
  sessions: SessionInfo[];
  primarySessionId: string;
  splitSessionId: string | null;
  onSetSplit: (sessionId: string) => void;
  onClearSplit: () => void;
}

const SPLIT_MIME = "text/x-hive-session-split";

export function SessionSplitArea({
  containerId,
  containerName,
  hasClaudeCli,
  sessions,
  primarySessionId,
  splitSessionId,
  onSetSplit,
  onClearSplit,
}: Props) {
  const splitSession =
    splitSessionId !== null && splitSessionId !== primarySessionId
      ? (sessions.find((s) => s.id === splitSessionId) ?? null)
      : null;
  const primaryName = sessions.find((s) => s.id === primarySessionId)?.name ?? "Main";

  // Show the drop overlay only while a session-split drag is active
  // anywhere on the page; the dataTransfer ``types`` list is the only
  // read-safe signal during drag, so we sniff it on the window-level
  // dragstart event.
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    function handleStart(e: globalThis.DragEvent) {
      if (e.dataTransfer?.types.includes(SPLIT_MIME)) setDragging(true);
    }
    function handleEnd() {
      setDragging(false);
    }
    window.addEventListener("dragstart", handleStart);
    window.addEventListener("dragend", handleEnd);
    window.addEventListener("drop", handleEnd);
    return () => {
      window.removeEventListener("dragstart", handleStart);
      window.removeEventListener("dragend", handleEnd);
      window.removeEventListener("drop", handleEnd);
    };
  }, []);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {splitSession !== null ? (
        <Group
          orientation="horizontal"
          id={`hive-session-split-${containerId}`}
          style={{ flex: 1, minWidth: 0, minHeight: 0 }}
        >
          <Panel minSize={20} defaultSize={50}>
            <div className="flex h-full min-h-0 min-w-0 flex-col p-2">
              <ErrorBoundary
                key={`eb-split-p-${containerId}-${primarySessionId}`}
                label={`the ${primaryName} terminal`}
              >
                <TerminalPane
                  key={`split-p-${containerId}-${primarySessionId}`}
                  containerId={containerId}
                  containerName={containerName}
                  hasClaudeCli={hasClaudeCli}
                  sessionId={primarySessionId}
                />
              </ErrorBoundary>
            </div>
          </Panel>
          <Separator
            className="w-0.5 cursor-col-resize bg-[#2b2b2b] transition-colors hover:bg-[#0078d4]"
            aria-label="Resize split terminals"
          />
          <Panel minSize={20} defaultSize={50}>
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-[#2b2b2b] bg-[#1a1a1a] px-2 py-1 text-[10px] text-[#858585]">
                <span className="truncate">{splitSession.name}</span>
                <button
                  type="button"
                  onClick={onClearSplit}
                  className="rounded px-1 hover:bg-[#2a2a2a] hover:text-[#e7e7e7]"
                  aria-label="Close split session pane"
                  title="Close split"
                >
                  <X size={10} aria-hidden="true" />
                </button>
              </div>
              <div className="flex min-h-0 min-w-0 flex-1 p-2">
                <ErrorBoundary
                  key={`eb-split-s-${containerId}-${splitSession.id}`}
                  label={`the ${splitSession.name} terminal`}
                >
                  <TerminalPane
                    key={`split-s-${containerId}-${splitSession.id}`}
                    containerId={containerId}
                    containerName={containerName}
                    hasClaudeCli={hasClaudeCli}
                    sessionId={splitSession.id}
                  />
                </ErrorBoundary>
              </div>
            </div>
          </Panel>
        </Group>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 p-2">
          <ErrorBoundary
            key={`eb-${containerId}-${primarySessionId}`}
            label={`the ${containerName} terminal`}
          >
            <TerminalPane
              key={`${containerId}-${primarySessionId}`}
              containerId={containerId}
              containerName={containerName}
              hasClaudeCli={hasClaudeCli}
              sessionId={primarySessionId}
            />
          </ErrorBoundary>
        </div>
      )}

      {dragging && splitSession === null && (
        <DropOverlay
          onDrop={(sessionId) => {
            setDragging(false);
            if (sessionId !== primarySessionId) onSetSplit(sessionId);
          }}
        />
      )}
    </div>
  );
}

function DropOverlay({ onDrop }: { onDrop: (sessionId: string) => void }) {
  const [hover, setHover] = useState(false);

  const handlers = {
    onDragEnter: (e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(SPLIT_MIME)) return;
      e.preventDefault();
      setHover(true);
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer.types.includes(SPLIT_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setHover(true);
    },
    onDragLeave: () => setHover(false),
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setHover(false);
      const id = e.dataTransfer.getData(SPLIT_MIME);
      if (id) onDrop(id);
    },
  };

  return (
    <div className="pointer-events-none absolute inset-0 flex">
      <div className="h-full w-1/2" aria-hidden="true" />
      <div
        {...handlers}
        role="region"
        aria-label="Drop session to split right"
        className={`pointer-events-auto flex h-full w-1/2 items-center justify-center border-2 border-dashed text-[11px] font-medium text-white/90 transition-colors ${
          hover ? "border-[#0078d4] bg-[#0078d4]/20" : "border-[#0078d4]/40 bg-[#0078d4]/5"
        }`}
      >
        {hover ? "Drop to split right" : "Split →"}
      </div>
    </div>
  );
}
