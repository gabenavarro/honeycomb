/** User message bubble (M33). Right-aligned, max 78% width. */
import type { ChatTurn } from "../types";

interface Props {
  turn: ChatTurn;
}

export function MessageUser({ turn }: Props) {
  const text =
    turn.text ??
    turn.blocks
      .filter((b) => b.kind === "text")
      .map((b) => (b as { kind: "text"; text: string }).text)
      .join("");
  return (
    <div
      role="article"
      aria-label="User message"
      className="ml-auto max-w-[78%] rounded-lg border border-edge bg-card px-3 py-2 text-[13px] text-primary"
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">You</div>
      <div className="mt-1 whitespace-pre-wrap break-words">{text}</div>
    </div>
  );
}
