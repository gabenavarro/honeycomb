/** ModeToggleSheet — phone variant of the M33 ModeToggle (M36).
 *
 *  Wraps the Sheet primitive with three buttons (Code / Review /
 *  Plan). Selecting closes the sheet immediately.
 */
import { Sheet } from "../Sheet";
import type { ChatMode } from "./ModeToggle";

interface Props {
  open: boolean;
  mode: ChatMode;
  onSelect: (mode: ChatMode) => void;
  onClose: () => void;
}

const MODES: { id: ChatMode; label: string }[] = [
  { id: "code", label: "Code" },
  { id: "review", label: "Review" },
  { id: "plan", label: "Plan" },
];

export function ModeToggleSheet({ open, mode, onSelect, onClose }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title="Chat mode" maxHeight="auto">
      <ul className="flex flex-col gap-1">
        {MODES.map((m) => {
          const active = m.id === mode;
          return (
            <li key={m.id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => {
                  onSelect(m.id);
                  onClose();
                }}
                className={`flex min-h-[44px] w-full items-center justify-between rounded px-3 py-2 text-left text-[14px] ${
                  active ? "bg-accent/10 text-primary" : "text-secondary hover:bg-chip"
                }`}
              >
                <span>{m.label}</span>
                {active && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
