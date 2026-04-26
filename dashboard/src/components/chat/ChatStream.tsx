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
}

export function ChatStream({ turns, renderTurn }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastTurn = turns[turns.length - 1];

  useEffect(() => {
    if (lastTurn?.streaming) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [lastTurn?.streaming, lastTurn?.blocks]);

  if (turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-secondary">No turns yet — say something to start the chat.</p>
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
      <div ref={endRef} />
    </div>
  );
}

function PlaceholderTurn({ turn }: { turn: ChatTurn }) {
  return (
    <div
      className={`rounded border border-edge bg-card px-3 py-2 text-[12px] ${
        turn.role === "user" ? "ml-auto max-w-[78%] text-primary" : "text-primary"
      }`}
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
        {turn.role === "user" ? "You" : "Claude"}
        {turn.streaming && <span className="ml-2 text-think">streaming…</span>}
      </div>
      <div className="mt-1 font-mono text-[11px] text-secondary">
        blocks: {turn.blocks.length} · {turn.streaming ? "in flight" : "complete"}
      </div>
    </div>
  );
}
