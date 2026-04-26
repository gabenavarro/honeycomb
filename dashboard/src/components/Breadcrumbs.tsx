/** Compact path breadcrumbs for the active container (M17).
 *
 * Sits between the ContainerTabs strip and the session sub-tabs. Clicks
 * on a segment navigate up to it; the folder icon swaps the display
 * into a text input the user can edit to jump anywhere absolute.
 *
 * The path defaults to the container's WORKDIR (fetched once via
 * ``/api/containers/{id}/workdir``) and persists per-container in
 * localStorage — switching back to a container keeps its last browsed
 * location.
 */

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, Pencil } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { getContainerWorkdir } from "../lib/api";

interface Props {
  containerId: number;
  path: string;
  onPathChange: (path: string) => void;
}

export function Breadcrumbs({ containerId, path, onPathChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);

  // On mount (or container switch) fetch the container's WORKDIR. We
  // only adopt it when the user hasn't already picked something — if
  // ``path`` is already non-empty and absolute, the caller's
  // persisted value wins.
  const { data: workdir } = useQuery({
    queryKey: ["workdir", containerId],
    queryFn: () => getContainerWorkdir(containerId),
    staleTime: 60_000,
  });
  useEffect(() => {
    if (!workdir) return;
    if (!path || !path.startsWith("/")) {
      onPathChange(workdir.path);
    }
  }, [workdir, path, onPathChange]);

  useEffect(() => {
    setDraft(path);
  }, [path]);

  const segments = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    const out: { label: string; absPath: string }[] = [{ label: "/", absPath: "/" }];
    let cursor = "";
    for (const p of parts) {
      cursor = `${cursor}/${p}`;
      out.push({ label: p, absPath: cursor });
    }
    return out;
  }, [path]);

  const submit = () => {
    const next = draft.trim();
    if (next && next.startsWith("/")) {
      onPathChange(next);
    } else {
      setDraft(path);
    }
    setEditing(false);
  };

  return (
    <div className="border-edge bg-pane text-secondary flex shrink-0 items-center gap-1 border-b px-2 py-1 text-[11px]">
      <button
        type="button"
        onClick={() => setEditing((v) => !v)}
        className="text-secondary hover:bg-chip hover:text-primary flex items-center rounded p-0.5"
        aria-label="Edit path"
        title={editing ? "Cancel path edit" : "Edit path"}
      >
        {editing ? <Pencil size={11} /> : <Folder size={11} />}
      </button>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={submit}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") {
              setDraft(path);
              setEditing(false);
            }
          }}
          className="border-edge bg-page text-primary focus:border-accent flex-1 rounded border px-2 py-0.5 font-mono text-[11px] focus:outline-none"
          placeholder="/absolute/path"
          aria-label="Absolute path inside the container"
        />
      ) : (
        <nav aria-label="Path breadcrumb" className="flex min-w-0 flex-1 items-center gap-0.5">
          {segments.map((seg, i) => (
            <span key={seg.absPath} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight size={10} className="text-muted shrink-0" />}
              <button
                type="button"
                onClick={() => onPathChange(seg.absPath)}
                className={`hover:bg-chip hover:text-primary max-w-[14rem] truncate rounded px-1 font-mono ${
                  i === segments.length - 1 ? "text-primary" : "text-secondary"
                }`}
                title={seg.absPath}
              >
                {seg.label}
              </button>
            </span>
          ))}
        </nav>
      )}
    </div>
  );
}
