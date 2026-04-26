/** Quick · Standard · Deep · Max segmented control (M33 visual; M34
 * wires real `thinking.budget_tokens` semantics).
 */
import { useEffect, useState } from "react";

export type ChatEffort = "quick" | "standard" | "deep" | "max";

const EFFORTS: readonly ChatEffort[] = ["quick", "standard", "deep", "max"] as const;
const EFFORT_LABEL: Record<ChatEffort, string> = {
  quick: "Quick",
  standard: "Standard",
  deep: "Deep",
  max: "Max",
};

interface Props {
  sessionId: string;
}

function storageKey(sessionId: string) {
  return `hive:chat:${sessionId}:effort`;
}

function readStored(sessionId: string): ChatEffort {
  if (typeof window === "undefined") return "standard";
  const v = window.localStorage.getItem(storageKey(sessionId));
  return v === "quick" || v === "deep" || v === "max" ? v : "standard";
}

export function EffortControl({ sessionId }: Props) {
  const [effort, setEffort] = useState<ChatEffort>(() => readStored(sessionId));
  useEffect(() => {
    setEffort(readStored(sessionId));
  }, [sessionId]);

  const update = (next: ChatEffort) => {
    setEffort(next);
    window.localStorage.setItem(storageKey(sessionId), next);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Effort"
      className="inline-flex items-center rounded-md border border-edge bg-pane p-0.5"
    >
      {EFFORTS.map((e) => {
        const active = e === effort;
        return (
          <button
            key={e}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => update(e)}
            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              active ? "bg-chip text-primary" : "text-secondary hover:text-primary"
            }`}
          >
            {EFFORT_LABEL[e]}
          </button>
        );
      })}
    </div>
  );
}
