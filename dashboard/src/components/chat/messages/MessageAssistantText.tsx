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
    <div role="article" aria-label="Assistant message" className="text-[13px] text-primary">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-claude">Claude</div>
      <div className="mt-1 whitespace-pre-wrap break-words">
        {text}
        {turn.streaming && (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-claude align-middle"
          />
        )}
      </div>
    </div>
  );
}
