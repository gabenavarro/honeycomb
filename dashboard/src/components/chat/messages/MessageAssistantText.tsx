/** Assistant text message (M33). Renders the concatenated text blocks
 *  with a streaming cursor when the turn is in flight. Markdown
 *  rendering is intentionally out of scope for M33 (M34 may add it);
 *  for now we render plain text + preserve newlines. */
import type { ChatTurn } from "../types";

interface Props {
  turn: ChatTurn;
}

export function MessageAssistantText({ turn }: Props) {
  const text = turn.blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b as { kind: "text"; text: string }).text)
    .join("");
  return (
    <div role="article" aria-label="Assistant message" className="text-primary text-[13px]">
      <div className="text-claude text-[10px] font-semibold tracking-wider uppercase">Claude</div>
      <div className="mt-1 break-words whitespace-pre-wrap">
        {text}
        {turn.streaming && (
          <span
            aria-hidden="true"
            className="bg-claude ml-0.5 inline-block h-3 w-1 animate-pulse align-middle"
          />
        )}
      </div>
    </div>
  );
}
