/** Sub-tab strip rendered under ContainerTabs for the active container's
 * sessions (M16). Rename support added in M20.
 *
 * Session identity is purely client-side: each entry has ``{id, name}``.
 * The ``id`` feeds into ``TerminalPane`` which derives the ``sessionKey``
 * passed to ``PtyPane`` — a unique key per session gets a unique PTY in
 * the hub's ``PtyRegistry``. Names are human-friendly labels the user
 * picks when spawning a session, and can be edited at any time:
 *
 * - Double-click the tab label to inline-rename.
 * - A small pencil (edit) affordance appears on the active tab for
 *   discoverability — clicking also enters rename mode.
 * - Enter commits, Escape cancels, blur auto-commits.
 */

import { Pencil, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
  onRename: (id: string, name: string) => void;
}

export function SessionSubTabs({ sessions, activeId, onFocus, onClose, onNew, onRename }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div
      role="tablist"
      aria-label="Container sessions"
      className="flex shrink-0 items-center gap-0 overflow-x-auto border-b border-[#2b2b2b] bg-[#1a1a1a] px-1"
    >
      {sessions.map((s) => (
        <SessionTab
          key={s.id}
          session={s}
          active={s.id === activeId}
          canClose={sessions.length > 1}
          editing={editingId === s.id}
          onStartEdit={() => setEditingId(s.id)}
          onEndEdit={() => setEditingId(null)}
          onFocus={onFocus}
          onClose={onClose}
          onRename={onRename}
        />
      ))}
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

interface TabProps {
  session: SessionInfo;
  active: boolean;
  canClose: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

function SessionTab({
  session,
  active,
  canClose,
  editing,
  onStartEdit,
  onEndEdit,
  onFocus,
  onClose,
  onRename,
}: TabProps) {
  const [draft, setDraft] = useState(session.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(session.name);
  }, [session.name]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = useCallback(() => {
    const next = draft.trim();
    if (next && next !== session.name) onRename(session.id, next);
    onEndEdit();
  }, [draft, session.id, session.name, onRename, onEndEdit]);

  const cancel = useCallback(() => {
    setDraft(session.name);
    onEndEdit();
  }, [session.name, onEndEdit]);

  return (
    <div className="flex items-center">
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => {
          if (!editing) onFocus(session.id);
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          onStartEdit();
        }}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onClose(session.id);
          }
        }}
        className={`flex items-center gap-1.5 border-r border-[#2b2b2b] px-2.5 py-1 text-[10px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0078d4] focus-visible:ring-inset ${
          active
            ? "bg-[#1e1e1e] text-[#e7e7e7]"
            : "bg-[#222] text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#c0c0c0]"
        }`}
      >
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
            className="w-[110px] rounded border border-[#3c3c3c] bg-[#1e1e1e] px-1 text-[10px] text-[#e7e7e7] focus:border-[#0078d4] focus:outline-none"
            aria-label={`Rename session ${session.name}`}
          />
        ) : (
          <span className="max-w-[120px] truncate" title="Double-click to rename">
            {session.name}
          </span>
        )}

        {active && !editing && (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onStartEdit();
            }}
            className="ml-0.5 inline-flex cursor-pointer rounded p-0.5 opacity-40 hover:bg-[#444] hover:opacity-100"
            aria-label={`Rename session ${session.name}`}
            title="Rename session"
          >
            <Pencil size={8} aria-hidden="true" />
          </span>
        )}

        {canClose && !editing && (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onClose(session.id);
            }}
            className="ml-1 inline-flex cursor-pointer rounded p-0.5 opacity-40 hover:bg-[#444] hover:opacity-100"
            aria-label={`Close session ${session.name}`}
          >
            <X size={9} aria-hidden="true" />
          </span>
        )}
      </button>
    </div>
  );
}
