/** Scope toggle for Library: "active" (current workspace) vs "fleet" (all containers). M35. */
import { useEffect, useState } from "react";

export type LibraryScope = "active" | "fleet";

const STORAGE_KEY = "hive:library:scope";

interface Props {
  activeContainerName: string | null;
  onScopeChange: (scope: LibraryScope) => void;
}

export function ScopeToggle({ activeContainerName, onScopeChange }: Props) {
  const [scope, setScope] = useState<LibraryScope>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "active" || stored === "fleet") return stored;
    } catch {
      // ignore
    }
    return "active";
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, scope);
    } catch {
      // ignore
    }
    onScopeChange(scope);
  }, [scope, onScopeChange]);

  function toggle() {
    setScope((prev) => (prev === "active" ? "fleet" : "active"));
  }

  return (
    <div className="border-edge bg-input flex items-center gap-1 rounded border p-0.5 text-[11px]">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={scope === "active"}
        className={[
          "rounded px-2 py-0.5 transition-colors",
          scope === "active"
            ? "bg-accent/10 text-accent font-medium"
            : "text-secondary hover:text-primary",
        ].join(" ")}
      >
        {activeContainerName ?? "(no workspace)"}
      </button>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={scope === "fleet"}
        className={[
          "rounded px-2 py-0.5 transition-colors",
          scope === "fleet"
            ? "bg-accent/10 text-accent font-medium"
            : "text-secondary hover:text-primary",
        ].join(" ")}
      >
        Fleet
      </button>
    </div>
  );
}
