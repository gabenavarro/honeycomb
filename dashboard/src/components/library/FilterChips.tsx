/** Filter chip row for the Library sidebar (M35). */
import { useState } from "react";

import type { Artifact, ArtifactType } from "../../lib/types";
import { MoreCustomizationSheet } from "./MoreCustomizationSheet";

// ─── Module-private constants ─────────────────────────────────────────────────

const STORAGE_KEY = "hive:library:primary-types";

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

const DEFAULT_PRIMARY: ArtifactType[] = ["plan", "review", "edit", "snippet"];

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

function readStored(): ArtifactType[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PRIMARY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_PRIMARY;
    const valid = parsed.filter((v): v is ArtifactType =>
      (ALL_TYPES as string[]).includes(v as string),
    );
    return valid.length > 0 ? valid : DEFAULT_PRIMARY;
  } catch {
    return DEFAULT_PRIMARY;
  }
}

// ─── Sub-component: ChipButton ────────────────────────────────────────────────

interface ChipButtonProps {
  label: string;
  count?: number;
  pressed: boolean;
  onClick: () => void;
}

function ChipButton({ label, count, pressed, onClick }: ChipButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={[
        "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        pressed
          ? "border-accent bg-accent/10 text-accent"
          : "border-edge bg-chip text-secondary hover:text-primary",
      ].join(" ")}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span
          aria-label={`${count} artifacts`}
          className={[
            "rounded-full px-1 text-[10px] font-medium",
            pressed ? "bg-accent/20 text-accent" : "bg-edge text-faint",
          ].join(" ")}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  selected: ArtifactType[];
  onSelectedChange: (next: ArtifactType[]) => void;
  artifacts: Artifact[];
}

export function FilterChips({ selected, onSelectedChange, artifacts }: Props) {
  const [primaryTypes, setPrimaryTypes] = useState<ArtifactType[]>(readStored);
  const [sheetOpen, setSheetOpen] = useState(false);

  function handlePrimaryTypesChange(next: ArtifactType[]) {
    setPrimaryTypes(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  function countForType(type: ArtifactType): number {
    return artifacts.filter((a) => a.type === type).length;
  }

  function toggleType(type: ArtifactType) {
    if (selected.includes(type)) {
      onSelectedChange(selected.filter((t) => t !== type));
    } else {
      onSelectedChange([...selected, type]);
    }
  }

  function clearAll() {
    onSelectedChange([]);
  }

  const allSelected = selected.length === 0;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
        {/* All chip */}
        <ChipButton label="All" pressed={allSelected} onClick={clearAll} count={artifacts.length} />

        {/* Primary type chips */}
        {primaryTypes.map((type) => (
          <ChipButton
            key={type}
            label={TYPE_LABEL[type]}
            pressed={selected.includes(type)}
            onClick={() => toggleType(type)}
            count={countForType(type)}
          />
        ))}

        {/* ⋯ More button */}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label="More filter options"
          className="border-edge bg-chip text-muted hover:text-secondary flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px]"
        >
          ⋯ More
        </button>
      </div>

      {sheetOpen && (
        <MoreCustomizationSheet
          primaryTypes={primaryTypes}
          onPrimaryTypesChange={handlePrimaryTypesChange}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </>
  );
}
