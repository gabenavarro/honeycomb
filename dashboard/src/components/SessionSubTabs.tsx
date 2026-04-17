/** Sub-tab strip rendered under ContainerTabs for the active container's
 * sessions (M16).
 *
 * Session identity is purely client-side: each entry has ``{id, name}``.
 * The ``id`` feeds into ``TerminalPane`` which derives the ``sessionKey``
 * passed to ``PtyPane`` — a unique key per session gets a unique PTY in
 * the hub's ``PtyRegistry``. Names are human-friendly labels the user
 * picks when spawning a session.
 *
 * The sub-tabs render only when the active container has ≥1 session
 * (always true after M16's migration: every open container gets a
 * ``{id:"default", name:"Main"}`` on first render).
 */

import { Plus, X } from "lucide-react";

export interface SessionInfo {
  id: string;
  name: string;
}

interface Props {
  sessions: SessionInfo[];
  activeId: string | null;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

export function SessionSubTabs({ sessions, activeId, onFocus, onClose, onNew }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Container sessions"
      className="flex shrink-0 items-center gap-0 overflow-x-auto border-b border-[#2b2b2b] bg-[#1a1a1a] px-1"
    >
      {sessions.map((s) => {
        const active = s.id === activeId;
        return (
          <div key={s.id} className="flex items-center">
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onFocus(s.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(s.id);
                }
              }}
              className={`flex items-center gap-1.5 border-r border-[#2b2b2b] px-2.5 py-1 text-[10px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0078d4] focus-visible:ring-inset ${
                active
                  ? "bg-[#1e1e1e] text-[#e7e7e7]"
                  : "bg-[#222] text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#c0c0c0]"
              }`}
            >
              <span className="max-w-[120px] truncate">{s.name}</span>
              {sessions.length > 1 && (
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(s.id);
                  }}
                  className="ml-1 inline-flex cursor-pointer rounded p-0.5 opacity-40 hover:bg-[#444] hover:opacity-100"
                  aria-label={`Close session ${s.name}`}
                >
                  <X size={9} aria-hidden="true" />
                </span>
              )}
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onNew}
        className="flex items-center gap-1 px-2 py-1 text-[10px] text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
        aria-label="New session"
        title="New session"
      >
        <Plus size={10} />
        New
      </button>
    </div>
  );
}
