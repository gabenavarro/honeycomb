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
  /** M21 D — reorder the session list. The caller gets (fromId, toId)
   * and is responsible for moving ``fromId`` to occupy ``toId``'s
   * slot (insertion before the target). */
  onReorder: (fromId: string, toId: string) => void;
}

export function SessionSubTabs({
  sessions,
  activeId,
  onFocus,
  onClose,
  onNew,
  onRename,
  onReorder,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  return (
    <div
      role="tablist"
      aria-label="Container sessions"
      className="flex shrink-0 items-center gap-0 overflow-x-auto border-b border-edge bg-[#1a1a1a] px-1"
    >
      {sessions.map((s) => (
        <SessionTab
          key={s.id}
          session={s}
          active={s.id === activeId}
          canClose={sessions.length > 1}
          editing={editingId === s.id}
          dragging={draggingId === s.id}
          dragOver={dragOverId === s.id && draggingId !== s.id}
          onStartEdit={() => setEditingId(s.id)}
          onEndEdit={() => setEditingId(null)}
          onFocus={onFocus}
          onClose={onClose}
          onRename={onRename}
          onDragStart={(id) => setDraggingId(id)}
          onDragEnter={(id) => setDragOverId(id)}
          onDragEnd={() => {
            setDraggingId(null);
            setDragOverId(null);
          }}
          onDrop={(fromIdDt, toId) => {
            // Prefer the id from dataTransfer (reliable with synthetic events);
            // fall back to React state for native drags.
            const from = fromIdDt || draggingId;
            if (from && from !== toId) onReorder(from, toId);
            setDraggingId(null);
            setDragOverId(null);
          }}
        />
      ))}
      <button
        type="button"
        onClick={onNew}
        className="flex items-center gap-1 px-2 py-1 text-[10px] text-secondary hover:bg-chip hover:text-primary"
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
  dragging: boolean;
  dragOver: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDragStart: (id: string) => void;
  onDragEnter: (id: string) => void;
  onDragEnd: () => void;
  onDrop: (fromId: string | null, toId: string) => void;
}

function SessionTab({
  session,
  active,
  canClose,
  editing,
  dragging,
  dragOver,
  onStartEdit,
  onEndEdit,
  onFocus,
  onClose,
  onRename,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
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

  // M21 D — drag state classes. ``dragging`` ghosts the source, ``dragOver``
  // shows a left-edge caret indicating where the drop will land.
  const dragClasses = [
    dragging ? "opacity-50" : "",
    dragOver ? "border-l-2 border-l-accent" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="flex items-center">
      <button
        type="button"
        role="tab"
        aria-selected={active}
        draggable={!editing}
        onDragStart={(e) => {
          if (editing) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/x-hive-session", session.id);
          // M22.4 — the same drag also lets the user split the editor
          // pane by dropping on the main area. A separate MIME keeps
          // the split handler from firing when a user only meant to
          // reorder tabs within the strip.
          e.dataTransfer.setData("text/x-hive-session-split", session.id);
          onDragStart(session.id);
        }}
        onDragEnter={() => onDragEnter(session.id)}
        onDragOver={(e) => {
          // Required for drop to fire.
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          e.preventDefault();
          // Read the dragged session id from dataTransfer so synthetic-event
          // test dispatches work even when React state (draggingId) hasn't
          // flushed yet.
          const fromId = e.dataTransfer.getData("text/x-hive-session");
          onDrop(fromId || null, session.id);
        }}
        onDragEnd={onDragEnd}
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
        className={`flex items-center gap-1.5 border-r border-edge px-2.5 py-1 text-[10px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
          active
            ? "bg-page text-primary"
            : "bg-[#222] text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-primary"
        } ${dragClasses}`}
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
            className="w-[110px] rounded border border-[#3c3c3c] bg-page px-1 text-[10px] text-primary focus:border-accent focus:outline-none"
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
