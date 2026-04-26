/** Modal sheet for customising which artifact types appear as primary chips. M35. */
import { Star } from "lucide-react";

import type { ArtifactType } from "../../lib/types";

const TYPE_LABEL: Record<ArtifactType, string> = {
  plan: "Plan",
  review: "Review",
  edit: "Edit",
  snippet: "Snippet",
  note: "Note",
  skill: "Skill",
  subagent: "Subagent",
  spec: "Spec",
};

const ALL_TYPES: ArtifactType[] = [
  "plan",
  "review",
  "edit",
  "snippet",
  "note",
  "skill",
  "subagent",
  "spec",
];

const MAX_PRIMARY = 4;

interface Props {
  primaryTypes: ArtifactType[];
  onPrimaryTypesChange: (next: ArtifactType[]) => void;
  onClose: () => void;
}

export function MoreCustomizationSheet({ primaryTypes, onPrimaryTypesChange, onClose }: Props) {
  function handleToggle(type: ArtifactType) {
    if (primaryTypes.includes(type)) {
      // Demote: remove from primary
      onPrimaryTypesChange(primaryTypes.filter((t) => t !== type));
    } else {
      // Promote: add to primary, enforcing cap by dropping the oldest (first in array)
      const next = [...primaryTypes, type];
      if (next.length > MAX_PRIMARY) {
        next.shift();
      }
      onPrimaryTypesChange(next);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div aria-hidden="true" className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      {/* Sheet */}
      <div
        role="dialog"
        aria-label="Customize artifact chips"
        aria-modal="true"
        className="border-edge bg-pane shadow-pop fixed top-1/2 left-1/2 z-50 w-64 -translate-x-1/2 -translate-y-1/2 rounded-lg border p-4"
      >
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-primary text-[12px] font-semibold">Customise chips</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-primary text-[12px]"
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <ul className="flex flex-col gap-1">
          {ALL_TYPES.map((type) => {
            const isPrimary = primaryTypes.includes(type);
            return (
              <li key={type} className="flex items-center justify-between">
                <span className="text-secondary text-[12px]">{TYPE_LABEL[type]}</span>
                <button
                  type="button"
                  onClick={() => handleToggle(type)}
                  aria-label={isPrimary ? `Remove ${type} from primary` : `Add ${type} to primary`}
                  aria-pressed={isPrimary}
                  className="transition-colors"
                >
                  <Star
                    size={12}
                    aria-hidden="true"
                    className={isPrimary ? "fill-think text-think" : "text-muted"}
                  />
                </button>
              </li>
            );
          })}
        </ul>
        <p className="text-faint mt-3 text-[10px]">Up to {MAX_PRIMARY} primary chips.</p>
      </div>
    </>
  );
}
