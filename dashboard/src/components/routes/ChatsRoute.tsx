/** Chats route (M32 bridge → M33 chat surface).
 *
 * Sidebar: ContainerList. Main pane: branches on the active named
 * session's kind. For "claude" the new ChatThread surface (Task 12)
 * renders via ChatThreadWrapper (owns useChatStream + send handler).
 * For "shell" the existing M32 PTY-based path stays intact:
 * WorkspacePill + Breadcrumbs + SessionSubTabs + SessionSplitArea
 * (or FileViewer / DiffViewerTab when one is opened).
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Breadcrumbs } from "../Breadcrumbs";
import { ContainerList } from "../ContainerList";
import { DiffViewerTab } from "../DiffViewerTab";
import { ErrorBoundary } from "../ErrorBoundary";
import { FileViewer } from "../FileViewer";
import { HealthTimeline } from "../HealthTimeline";
import { SessionSplitArea } from "../SessionSplitArea";
import { SessionSubTabs, type SessionInfo } from "../SessionSubTabs";
import { WorkspacePill } from "../WorkspacePill";
import { ChatThread } from "../chat/ChatThread";
import type { ChatMode } from "../chat/ModeToggle";
import type { ChatTabInfo } from "../chat/ChatTabStrip";
import type { ChatTurn } from "../chat/types";
import { useChatStream } from "../../hooks/useChatStream";
import { listContainerSessions, getSettings, postChatTurn } from "../../lib/api";
import type { ContainerRecord, DiffEvent, NamedSession } from "../../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainer: ContainerRecord | undefined;
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;

  activeSessions: SessionInfo[];
  namedSessions: NamedSession[];
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
  namedSessions,
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

  // M33 — branch on the active named session's kind. "claude" sessions
  // render the new chat surface; "shell" sessions keep the existing
  // PTY-based render path below.
  const activeNamedSession = namedSessions.find((s) => s.session_id === activeSessionId) ?? null;
  const isClaudeKind = activeNamedSession?.kind === "claude";

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
        {isClaudeKind && activeNamedSession && activeContainer !== undefined ? (
          <ChatThreadWrapper
            activeNamedSession={activeNamedSession}
            namedSessions={namedSessions}
            containers={containers}
            activeContainerId={activeContainerId}
            onSelectContainer={onSelectContainer}
            onFocusSession={onFocusSession}
            onCloseSession={(id) => void onCloseSession(id)}
            onNewSession={onNewSession}
          />
        ) : (
          <>
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
          </>
        )}
      </main>
    </div>
  );
}

interface WrapperProps {
  activeNamedSession: NamedSession;
  namedSessions: NamedSession[];
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
  onFocusSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onNewSession: () => void;
}

function ChatThreadWrapper({
  activeNamedSession,
  namedSessions,
  containers,
  activeContainerId,
  onSelectContainer,
  onFocusSession,
  onCloseSession,
  onNewSession,
}: WrapperProps) {
  const sessionId = activeNamedSession.session_id;
  const { turns, clearTurns } = useChatStream(sessionId);
  const [pending, setPending] = useState(false);
  const mode: ChatMode =
    typeof window !== "undefined"
      ? ((window.localStorage.getItem(`hive:chat:${sessionId}:mode`) as ChatMode | null) ?? "code")
      : "code";

  const tabs: ChatTabInfo[] = namedSessions
    .filter((s) => s.kind === "claude")
    .map((s) => ({
      id: s.session_id,
      name: s.name,
      mode: (typeof window !== "undefined"
        ? ((window.localStorage.getItem(`hive:chat:${s.session_id}:mode`) as ChatMode | null) ??
          "code")
        : "code") as ChatMode,
    }));

  const send = async (text: string) => {
    setPending(true);
    try {
      await postChatTurn(sessionId, { text });
    } finally {
      setPending(false);
    }
  };

  const retry = (turn: ChatTurn) => {
    clearTurns();
    void send(turn.text ?? "");
  };

  const fork = (turn: ChatTurn) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        `hive:chat:${sessionId}:pending-fork`,
        JSON.stringify({ at_message: turn.id }),
      );
    }
    onNewSession();
  };

  const edit = (turn: ChatTurn) => {
    const next = window.prompt("Edit your message:", turn.text ?? "");
    if (next === null) return;
    clearTurns();
    void send(next);
  };

  return (
    <ChatThread
      sessionId={sessionId}
      containers={containers}
      activeContainerId={activeContainerId}
      onSelectContainer={onSelectContainer}
      tabs={tabs}
      activeTabId={sessionId}
      onFocusTab={onFocusSession}
      onCloseTab={onCloseSession}
      onNewTab={onNewSession}
      turns={turns}
      mode={mode}
      pending={pending}
      onSend={send}
      onRetry={retry}
      onFork={fork}
      onEdit={edit}
    />
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
