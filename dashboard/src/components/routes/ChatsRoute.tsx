/** Chats route (M32 bridge).
 *
 * Sidebar: ContainerList. Main pane: WorkspacePill + Breadcrumbs +
 * SessionSubTabs + SessionSplitArea (or FileViewer / DiffViewerTab
 * when one is opened from the palette / a click).
 *
 * The full chat surface (structured tool blocks, Thinking, streaming)
 * arrives in M33. M32 wires the existing PTY-based session UI behind
 * this route as a bridge so users can keep working while M33 ships.
 */
import { useQuery } from "@tanstack/react-query";

import { Breadcrumbs } from "../Breadcrumbs";
import { ContainerList } from "../ContainerList";
import { DiffViewerTab } from "../DiffViewerTab";
import { ErrorBoundary } from "../ErrorBoundary";
import { FileViewer } from "../FileViewer";
import { HealthTimeline } from "../HealthTimeline";
import { SessionSplitArea } from "../SessionSplitArea";
import { SessionSubTabs, type SessionInfo } from "../SessionSubTabs";
import { WorkspacePill } from "../WorkspacePill";
import { listContainerSessions, getSettings } from "../../lib/api";
import type { ContainerRecord, DiffEvent } from "../../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainer: ContainerRecord | undefined;
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;

  activeSessions: SessionInfo[];
  activeSessionId: string;
  activeSplitSessionId: string | null;
  onFocusSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRenameSession: (sessionId: string, nextName: string) => void;
  onReorderSession: (fromId: string, toId: string) => void;
  onSetSplitSession: (sessionId: string) => void;
  onClearSplitSession: () => void;

  activeFsPath: string;
  onFsPathChange: (path: string) => void;
  openedFile: string | null;
  onOpenFile: (path: string | null) => void;
  openedDiffEvent: DiffEvent | null;
  onOpenDiffEvent: (e: DiffEvent | null) => void;
}

export function ChatsRoute({
  containers,
  activeContainer,
  activeContainerId,
  onSelectContainer,
  activeSessions,
  activeSessionId,
  activeSplitSessionId,
  onFocusSession,
  onCloseSession,
  onNewSession,
  onRenameSession,
  onReorderSession,
  onSetSplitSession,
  onClearSplitSession,
  activeFsPath,
  onFsPathChange,
  openedFile,
  onOpenFile,
  openedDiffEvent,
  onOpenDiffEvent,
}: Props) {
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const timelineVisible = Boolean(
    (settingsData?.values as { timeline_visible?: boolean } | undefined)?.timeline_visible ?? true,
  );

  // Reference the live-sessions query so the existing M22.3 toast
  // logic in App.tsx still fires (it watches `containers.agent_status`
  // transitions; the query keeps the cache fresh).
  useQuery({
    queryKey: ["sessions", activeContainerId ?? 0],
    queryFn: () => listContainerSessions(activeContainerId!),
    enabled: activeContainerId !== null,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside
        aria-label="Chats sidebar"
        className="border-edge bg-pane flex w-72 shrink-0 flex-col border-r"
      >
        <header className="border-edge flex items-center justify-between border-b px-3 py-1.5">
          <h2 className="text-secondary text-[10px] font-semibold tracking-wider uppercase">
            Workspaces
          </h2>
        </header>
        <div className="flex-1 overflow-y-auto">
          <ContainerList selectedId={activeContainerId} onSelect={onSelectContainer} />
        </div>
      </aside>

      <main className="bg-page flex h-full min-w-0 flex-1 flex-col">
        <WorkspacePill
          containers={containers}
          activeContainerId={activeContainerId}
          onSelectContainer={onSelectContainer}
        />
        {activeContainer !== undefined ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <Breadcrumbs
              containerId={activeContainer.id}
              path={activeFsPath}
              onPathChange={onFsPathChange}
            />
            {timelineVisible && <HealthTimeline containerId={activeContainer.id} />}
            <SessionSubTabs
              sessions={activeSessions}
              activeId={activeSessionId}
              onFocus={onFocusSession}
              onClose={onCloseSession}
              onNew={onNewSession}
              onRename={onRenameSession}
              onReorder={onReorderSession}
            />
            {openedFile !== null ? (
              <div className="flex min-h-0 min-w-0 flex-1">
                <ErrorBoundary
                  key={`eb-file-${activeContainer.id}-${openedFile}`}
                  label={`the ${openedFile} viewer`}
                >
                  <FileViewer
                    key={`${activeContainer.id}-${openedFile}`}
                    containerId={activeContainer.id}
                    path={openedFile}
                    onClose={() => onOpenFile(null)}
                  />
                </ErrorBoundary>
              </div>
            ) : openedDiffEvent !== null ? (
              <div className="flex min-h-0 min-w-0 flex-1">
                <ErrorBoundary
                  key={`eb-diff-${activeContainer.id}-${openedDiffEvent.event_id}`}
                  label={`the diff viewer for ${openedDiffEvent.path}`}
                >
                  <DiffViewerTab
                    key={`${activeContainer.id}-${openedDiffEvent.event_id}`}
                    event={openedDiffEvent}
                    onOpenFile={(path) => {
                      onOpenDiffEvent(null);
                      onOpenFile(path);
                    }}
                  />
                </ErrorBoundary>
              </div>
            ) : (
              <SessionSplitArea
                containerId={activeContainer.id}
                containerName={activeContainer.project_name}
                hasClaudeCli={activeContainer.has_claude_cli}
                sessions={activeSessions}
                primarySessionId={activeSessionId}
                splitSessionId={activeSplitSessionId}
                onSetSplit={onSetSplitSession}
                onClearSplit={onClearSplitSession}
              />
            )}
          </div>
        ) : (
          <ChatsEmptyState />
        )}
      </main>
    </div>
  );
}

function ChatsEmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-secondary text-sm">Pick a workspace from the sidebar to start a chat.</p>
      <p className="text-muted text-[11px]">
        Press <kbd className="border-edge rounded border px-1.5 py-0.5">Ctrl+K</kbd> for the command
        palette · <kbd className="border-edge rounded border px-1.5 py-0.5">Ctrl+B</kbd> to toggle
        the sidebar.
      </p>
    </div>
  );
}
