/** Filter chip row for the Library sidebar (M35). */
import { useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { Artifact, ArtifactType } from "../../lib/types";
import { ALL_TYPES, TYPE_LABEL } from "../../lib/artifact-meta";
import { MoreCustomizationSheet } from "./MoreCustomizationSheet";

// ─── Module-private constants ─────────────────────────────────────────────────

const STORAGE_KEY = "hive:library:primary-types";

const DEFAULT_PRIMARY: ArtifactType[] = ["plan", "review", "edit", "snippet"];

/** Validator for the persisted primary-types array.
 * Enforces the spec contract: exactly 4 entries, all valid ArtifactType values. */
function isValidPrimary(raw: unknown): raw is ArtifactType[] {
  if (!Array.isArray(raw) || raw.length !== 4) return false;
  return raw.every((v) => (ALL_TYPES as unknown[]).includes(v));
}

// ─── Sub-component: ChipButton ────────────────────────────────────────────────

interface ChipButtonProps {
  label: string;
  count: number;
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
      {/* Always render the badge so zero-count types give an explicit empty-state signal. */}
      <span
        aria-label={`${count} artifacts`}
        className={[
          "rounded-full px-1 text-[10px] font-medium",
          pressed ? "bg-accent/20 text-accent" : "bg-edge text-faint",
        ].join(" ")}
      >
        {count}
      </span>
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
  const [primaryTypes, setPrimaryTypes] = useLocalStorage<ArtifactType[]>(
    STORAGE_KEY,
    DEFAULT_PRIMARY,
    { validate: isValidPrimary },
  );
  const [sheetOpen, setSheetOpen] = useState(false);

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
        {[...primaryTypes].sort().map((type) => (
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
          onPrimaryTypesChange={setPrimaryTypes}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </>
  );
}
