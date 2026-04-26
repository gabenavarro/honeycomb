/** Chat thread container (M33).
 *
 * Composes header → tab strip → stream → composer with the per-turn
 * renderer that dispatches to the message components from Tasks 8-10.
 * Task 12 wires this into ChatsRoute via ChatThreadWrapper.
 */
import type { ContainerRecord } from "../../lib/types";
import { ChatHeader } from "./ChatHeader";
import { ChatTabStrip, type ChatTabInfo } from "./ChatTabStrip";
import { ChatComposer } from "./ChatComposer";
import { ChatStream } from "./ChatStream";
import { MessageActions } from "./MessageActions";
import { MessageAssistantText } from "./messages/MessageAssistantText";
import { MessageThinking } from "./messages/MessageThinking";
import { MessageUser } from "./messages/MessageUser";
import { renderToolBlock } from "./messages/dispatch";
import type { ChatTurn } from "./types";
import type { ChatMode } from "./ModeToggle";

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

  turns: ChatTurn[];
  mode: ChatMode;
  pending: boolean;
  onSend: (text: string) => void;
  onRetry: (turn: ChatTurn) => void;
  onFork: (turn: ChatTurn) => void;
  onEdit: (turn: ChatTurn) => void;
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
  turns,
  mode,
  pending,
  onSend,
  onRetry,
  onFork,
  onEdit,
}: Props) {
  const renderTurn = (turn: ChatTurn) => {
    const copy = () => {
      const text =
        turn.text ??
        turn.blocks
          .filter((b) => b.kind === "text")
          .map((b) => (b as { kind: "text"; text: string }).text)
          .join("");
      void navigator.clipboard.writeText(text);
    };
    return (
      <div className="group">
        <div className="mb-1 flex items-center justify-end">
          <MessageActions
            turn={turn}
            onRetry={() => onRetry(turn)}
            onFork={() => onFork(turn)}
            onCopy={copy}
            onEdit={() => onEdit(turn)}
          />
        </div>
        {turn.role === "user" && <MessageUser turn={turn} />}
        {turn.role === "assistant" && (
          <div className="space-y-2">
            {turn.blocks.map((block, i) => {
              if (block.kind === "text") {
                return <MessageAssistantText key={i} turn={{ ...turn, blocks: [block] }} />;
              }
              if (block.kind === "thinking") {
                return (
                  <MessageThinking key={i} thinking={block.thinking} streaming={turn.streaming} />
                );
              }
              return <div key={i}>{renderToolBlock(block)}</div>;
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="bg-page flex h-full min-h-0 min-w-0 flex-1 flex-col">
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
      <ChatStream turns={turns} renderTurn={renderTurn} />
      <ChatComposer sessionId={sessionId} mode={mode} disabled={pending} onSend={onSend} />
    </div>
  );
}
