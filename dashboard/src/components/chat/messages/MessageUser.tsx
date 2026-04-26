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
      className="border-edge bg-card text-primary ml-auto max-w-[78%] rounded-lg border px-3 py-2 text-[13px]"
    >
      <div className="text-muted text-[10px] font-semibold tracking-wider uppercase">You</div>
      <div className="mt-1 break-words whitespace-pre-wrap">{text}</div>
    </div>
  );
}
