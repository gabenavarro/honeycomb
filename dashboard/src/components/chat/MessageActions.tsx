/** Hover-revealed action bar for a single chat turn (M33).
 *
 * Buttons:
 *   - Retry — only on user turns; re-sends the same text + drops
 *     subsequent assistant turn from cache.
 *   - Fork  — only when both onFork is provided and turn.role can
 *     branch; creates a new chat tab.
 *   - Copy  — copies turn.text (user) or block text (assistant).
 *   - Edit  — only on user messages.
 */
import { Copy, GitBranch, Pencil, RotateCcw } from "lucide-react";

import type { ChatTurn } from "./types";

interface Props {
  turn: ChatTurn;
  onRetry?: () => void;
  onFork?: () => void;
  onCopy?: () => void;
  onEdit?: () => void;
}

export function MessageActions({ turn, onRetry, onFork, onCopy, onEdit }: Props) {
  const isUser = turn.role === "user";
  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
    >
      {isUser && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          aria-label="Retry"
          title="Retry"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <RotateCcw size={11} aria-hidden="true" />
        </button>
      )}
      {onFork && (
        <button
          type="button"
          onClick={onFork}
          aria-label="Fork"
          title="Fork from this message"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <GitBranch size={11} aria-hidden="true" />
        </button>
      )}
      {onCopy && (
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy"
          title="Copy"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <Copy size={11} aria-hidden="true" />
        </button>
      )}
      {isUser && onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit"
          title="Edit"
          className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
        >
          <Pencil size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
