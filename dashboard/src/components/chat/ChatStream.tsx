/** Chat stream (M33).
 *
 * Renders a flat list of ChatTurn; per-turn rendering delegates to
 * the message components from Tasks 8-10. Auto-scrolls to bottom
 * while a turn is streaming. Empty state shown when there are zero
 * turns.
 */
import { useEffect, useRef } from "react";

import type { ChatTurn } from "./types";

interface Props {
  turns: ChatTurn[];
  /** Optional render override — Task 12 passes a real renderer; the
   *  stub fallback shows a placeholder summary per turn. */
  renderTurn?: (turn: ChatTurn) => React.ReactNode;
  /** True while a turn is in flight and Claude hasn't returned content yet. */
  pending?: boolean;
}

export function ChatStream({ turns, renderTurn, pending }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastTurn = turns[turns.length - 1];

  // Show the thinking placeholder when pending and no assistant content has
  // arrived yet: no turns, the last turn is a user turn (Claude hasn't
  // responded), or the last assistant turn has zero blocks (silent window).
  const showPlaceholder =
    pending &&
    (turns.length === 0 || lastTurn.role !== "assistant" || lastTurn.blocks.length === 0);

  useEffect(() => {
    if (lastTurn?.streaming) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [lastTurn?.streaming, lastTurn?.blocks]);

  if (turns.length === 0 && !pending) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-secondary text-sm">No turns yet — say something to start the chat.</p>
      </div>
    );
  }

  return (
    <div role="log" aria-live="polite" className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      {turns.map((turn) =>
        renderTurn ? (
          <div key={turn.id}>{renderTurn(turn)}</div>
        ) : (
          <PlaceholderTurn key={turn.id} turn={turn} />
        ),
      )}
      {showPlaceholder && (
        <div className="text-secondary flex items-center gap-2 px-3 py-2 text-[12px]">
          <span
            className="bg-think inline-block h-2 w-2 animate-pulse rounded-full"
            aria-hidden="true"
          />
          <span className="animate-pulse">Claude is thinking…</span>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function PlaceholderTurn({ turn }: { turn: ChatTurn }) {
  return (
    <div
      className={`border-edge bg-card rounded border px-3 py-2 text-[12px] ${
        turn.role === "user" ? "text-primary ml-auto max-w-[78%]" : "text-primary"
      }`}
    >
      <div className="text-muted text-[10px] font-semibold tracking-wider uppercase">
        {turn.role === "user" ? "You" : "Claude"}
        {turn.streaming && <span className="text-think ml-2">streaming…</span>}
      </div>
      <div className="text-secondary mt-1 font-mono text-[11px]">
        blocks: {turn.blocks.length} · {turn.streaming ? "in flight" : "complete"}
      </div>
    </div>
  );
}
