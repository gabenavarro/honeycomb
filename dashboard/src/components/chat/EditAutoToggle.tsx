/** Edit-auto toggle (M34) — when on, Edit-tool calls auto-accept
 *  (--permission-mode acceptEdits). Plan mode overrides this; see
 *  hub/services/chat_stream.build_command for the precedence rules.
 *
 *  Persisted per chat in localStorage:hive:chat:<sessionId>:edit-auto.
 */
import { useEffect, useState } from "react";

interface Props {
  sessionId: string;
}

function storageKey(sessionId: string): string {
  return `hive:chat:${sessionId}:edit-auto`;
}

function readStored(sessionId: string): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(storageKey(sessionId)) === "true";
}

export function EditAutoToggle({ sessionId }: Props) {
  const [on, setOn] = useState<boolean>(() => readStored(sessionId));
  useEffect(() => {
    setOn(readStored(sessionId));
  }, [sessionId]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    window.localStorage.setItem(storageKey(sessionId), next ? "true" : "false");
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={toggle}
      className={`inline-flex items-center gap-1.5 rounded-md border border-edge px-2 py-0.5 text-[10px] transition-colors ${
        on ? "bg-write/20 text-write" : "bg-pane text-secondary hover:text-primary"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${on ? "bg-write" : "bg-faint"}`}
      />
      <span>Edit auto</span>
    </button>
  );
}

/** Read the persisted edit-auto value without rendering the toggle.
 *  Used by the chat dispatcher (Task 9 ChatThreadWrapper) to compose
 *  the postChatTurn payload. */
export function readEditAuto(sessionId: string): boolean {
  return readStored(sessionId);
}
