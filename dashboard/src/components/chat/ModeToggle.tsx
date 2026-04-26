/** Code/Review/Plan segmented control (M33).
 *
 * M33: persists to localStorage:hive:chat:<sessionId>:mode but has
 * no backend semantics. M34 wires per-mode subprocess args.
 */
import { useEffect, useState } from "react";

export type ChatMode = "code" | "review" | "plan";

const MODE_LABELS: Record<ChatMode, string> = {
  code: "Code",
  review: "Review",
  plan: "Plan",
};

const MODES: readonly ChatMode[] = ["code", "review", "plan"] as const;

interface Props {
  sessionId: string;
  onChange?: (mode: ChatMode) => void;
}

function storageKey(sessionId: string): string {
  return `hive:chat:${sessionId}:mode`;
}

function readStored(sessionId: string): ChatMode {
  if (typeof window === "undefined") return "code";
  const v = window.localStorage.getItem(storageKey(sessionId));
  return v === "review" || v === "plan" ? v : "code";
}

export function ModeToggle({ sessionId, onChange }: Props) {
  const [mode, setMode] = useState<ChatMode>(() => readStored(sessionId));
  useEffect(() => {
    setMode(readStored(sessionId));
  }, [sessionId]);
  const update = (next: ChatMode) => {
    setMode(next);
    window.localStorage.setItem(storageKey(sessionId), next);
    onChange?.(next);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Chat mode"
      className="inline-flex items-center rounded-md border border-edge bg-pane p-0.5"
    >
      {MODES.map((m) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => update(m)}
            className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
              active ? "bg-chip text-primary" : "text-secondary hover:text-primary"
            }`}
          >
            {MODE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
