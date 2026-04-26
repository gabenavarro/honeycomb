/** EffortPickerSheet — phone variant of the M34 effort picker (M36).
 *
 *  Wraps the Sheet primitive with four buttons. Reuses M34's
 *  ChatEffort union from EffortControl.tsx — DO NOT redefine.
 */
import { Sheet } from "../Sheet";
import type { ChatEffort } from "./EffortControl";

interface Props {
  open: boolean;
  effort: ChatEffort;
  onSelect: (effort: ChatEffort) => void;
  onClose: () => void;
}

const EFFORTS: { id: ChatEffort; label: string }[] = [
  { id: "quick", label: "Quick" },
  { id: "standard", label: "Standard" },
  { id: "deep", label: "Deep" },
  { id: "max", label: "Max" },
];

export function EffortPickerSheet({ open, effort, onSelect, onClose }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title="Effort level" maxHeight="auto">
      <ul className="flex flex-col gap-1">
        {EFFORTS.map((e) => {
          const active = e.id === effort;
          return (
            <li key={e.id}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => {
                  onSelect(e.id);
                  onClose();
                }}
                className={`flex min-h-[44px] w-full items-center justify-between rounded px-3 py-2 text-left text-[14px] ${
                  active ? "bg-accent/10 text-primary" : "text-secondary hover:bg-chip"
                }`}
              >
                <span>{e.label}</span>
                {active && <span aria-hidden="true">✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
