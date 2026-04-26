/** Scope toggle for Library: "active" (current workspace) vs "fleet" (all containers). M35. */
import { useEffect, useRef } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";

export type LibraryScope = "active" | "fleet";

const STORAGE_KEY = "hive:library:scope";

function isValidScope(raw: unknown): raw is LibraryScope {
  return raw === "active" || raw === "fleet";
}

interface Props {
  activeContainerName: string | null;
  onScopeChange: (scope: LibraryScope) => void;
}

export function ScopeToggle({ activeContainerName, onScopeChange }: Props) {
  const [scope, setScope] = useLocalStorage<LibraryScope>(STORAGE_KEY, "active", {
    validate: isValidScope,
  });

  // Ref-capture pattern: keep a stable ref to the latest onScopeChange so the
  // effect below doesn't need the callback in its deps. An unmemoized parent
  // would otherwise thrash the effect on every render, re-lifting scope
  // unnecessarily. Callback identity is intentionally excluded from deps.
  const onScopeChangeRef = useRef(onScopeChange);
  useEffect(() => {
    onScopeChangeRef.current = onScopeChange;
  });
  useEffect(() => {
    onScopeChangeRef.current(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

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
            ? "bg-accent/10 text-primary font-medium"
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
