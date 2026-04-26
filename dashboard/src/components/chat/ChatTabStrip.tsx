/** Tab strip below the chat header — one tab per chat session in the
 * active workspace. Mode-color icon per tab. + New at the right.
 */
import { Plus } from "lucide-react";

import type { ChatMode } from "./ModeToggle";

export interface ChatTabInfo {
  id: string;
  name: string;
  mode: ChatMode;
}

interface Props {
  tabs: ChatTabInfo[];
  activeId: string;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

const MODE_DOT: Record<ChatMode, string> = {
  code: "bg-tool",
  review: "bg-claude",
  plan: "bg-think",
};

export function ChatTabStrip({ tabs, activeId, onFocus, onClose, onNew }: Props) {
  return (
    <nav
      role="tablist"
      aria-label="Chat tabs"
      className="flex items-center gap-0.5 border-b border-edge bg-pane px-2 py-1"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onFocus(tab.id)}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(tab.id);
            }}
            className={`flex items-center gap-1.5 rounded-t px-2 py-1 text-[11px] transition-colors ${
              active
                ? "bg-page text-primary"
                : "text-secondary hover:bg-chip hover:text-primary"
            }`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${MODE_DOT[tab.mode]}`} />
            <span className="max-w-[10rem] truncate">{tab.name}</span>
            <span
              role="button"
              aria-label={`Close ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              className="rounded text-faint hover:bg-edge hover:text-primary"
            >
              ×
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={onNew}
        aria-label="New chat"
        className="ml-1 inline-flex items-center gap-1 rounded p-1 text-secondary hover:bg-chip hover:text-primary"
      >
        <Plus size={12} aria-hidden="true" />
      </button>
    </nav>
  );
}
