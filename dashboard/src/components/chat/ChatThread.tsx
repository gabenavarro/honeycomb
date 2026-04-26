/** Chat thread container (M33).
 *
 * Composes header → tab strip → stream → composer. Task 6 ships the
 * shell; Tasks 7-11 fill in the pieces. Task 12 wires the live data.
 */
import type { ContainerRecord } from "../../lib/types";
import { ChatHeader } from "./ChatHeader";
import { ChatTabStrip, type ChatTabInfo } from "./ChatTabStrip";

interface Props {
  sessionId: string;
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;

  tabs: ChatTabInfo[];
  activeTabId: string;
  onFocusTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}

export function ChatThread({
  sessionId,
  containers,
  activeContainerId,
  onSelectContainer,
  tabs,
  activeTabId,
  onFocusTab,
  onCloseTab,
  onNewTab,
}: Props) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-page">
      <ChatHeader
        sessionId={sessionId}
        containers={containers}
        activeContainerId={activeContainerId}
        onSelectContainer={onSelectContainer}
      />
      <ChatTabStrip
        tabs={tabs}
        activeId={activeTabId}
        onFocus={onFocusTab}
        onClose={onCloseTab}
        onNew={onNewTab}
      />
      <div className="flex flex-1 items-center justify-center text-sm text-muted">
        Chat stream + composer arrive in subsequent M33 tasks.
      </div>
    </div>
  );
}
