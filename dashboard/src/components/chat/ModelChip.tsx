/** Model picker chip (M33 visual; M34 wires real semantics).
 *
 * Click cycles through a placeholder list. Persisted to
 * localStorage:hive:chat:<sessionId>:model. The downstream chat
 * spawn does NOT yet pass --model — that's M34.
 */
import { ChevronDown, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

export type ChatModel = "opus-4-7" | "sonnet-4-6" | "haiku-4-5";

const MODEL_LABELS: Record<ChatModel, string> = {
  "opus-4-7": "Opus 4.7",
  "sonnet-4-6": "Sonnet 4.6",
  "haiku-4-5": "Haiku 4.5",
};

interface Props {
  sessionId: string;
}

function storageKey(sessionId: string) {
  return `hive:chat:${sessionId}:model`;
}

function readStored(sessionId: string): ChatModel {
  if (typeof window === "undefined") return "sonnet-4-6";
  const v = window.localStorage.getItem(storageKey(sessionId));
  return v === "opus-4-7" || v === "haiku-4-5" ? v : "sonnet-4-6";
}

export function ModelChip({ sessionId }: Props) {
  const [model, setModel] = useState<ChatModel>(() => readStored(sessionId));
  useEffect(() => {
    setModel(readStored(sessionId));
  }, [sessionId]);

  const cycle = () => {
    const order: ChatModel[] = ["opus-4-7", "sonnet-4-6", "haiku-4-5"];
    const next = order[(order.indexOf(model) + 1) % order.length];
    setModel(next);
    window.localStorage.setItem(storageKey(sessionId), next);
  };

  return (
    <button
      type="button"
      onClick={cycle}
      title="Model selection (full picker arrives in M34)"
      className="border-edge bg-pane text-primary hover:bg-chip inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]"
    >
      <Sparkles size={11} aria-hidden="true" className="text-claude" />
      <span>★ {MODEL_LABELS[model]}</span>
      <ChevronDown size={10} aria-hidden="true" />
    </button>
  );
}
