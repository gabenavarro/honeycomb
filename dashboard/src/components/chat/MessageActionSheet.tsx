/** MessageActionSheet — bottom action sheet for messages on phone (M36).
 *
 *  Replaces the hover-revealed action bar 1:1. Triggered by long-press
 *  in MessageBubble.
 *
 *  Edit is conditionally rendered (assistant messages don't have an
 *  edit affordance — the source-of-truth is the assistant model).
 */
import { Sheet } from "../Sheet";

interface Props {
  open: boolean;
  onClose: () => void;
  onRetry: () => void;
  onFork: () => void;
  onCopy: () => void;
  onEdit?: () => void; // omit for assistant messages
}

interface ActionRow {
  label: string;
  onClick: () => void;
}

export function MessageActionSheet({ open, onClose, onRetry, onFork, onCopy, onEdit }: Props) {
  const actions: ActionRow[] = [
    { label: "Retry", onClick: onRetry },
    { label: "Fork", onClick: onFork },
    { label: "Copy", onClick: onCopy },
  ];
  if (onEdit) actions.push({ label: "Edit", onClick: onEdit });

  return (
    <Sheet open={open} onClose={onClose} title="Message actions" maxHeight="auto">
      <ul className="flex flex-col gap-1">
        {actions.map((a) => (
          <li key={a.label}>
            <button
              type="button"
              onClick={() => {
                a.onClick();
                onClose();
              }}
              className="text-primary hover:bg-chip flex min-h-[44px] w-full items-center rounded px-3 py-2 text-left text-[14px]"
            >
              {a.label}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
