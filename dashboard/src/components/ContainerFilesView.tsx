/** Sidebar activity: files inside the active container (M17 + M18).
 *
 * Reads ``GET /api/containers/{id}/fs?path=<active>`` and lists entries.
 * Clicking a directory navigates into it; clicking a file opens the
 * viewer via ``onOpenFile``. Uses the active container's current path
 * (driven by App.tsx → Breadcrumbs) as the directory to show.
 */

import { useQuery } from "@tanstack/react-query";
import { Folder, FileText, Link2, ArrowUp } from "lucide-react";

import { listContainerDirectory } from "../lib/api";
import type { DirectoryListing, FsEntryKind } from "../lib/types";

interface Props {
  containerId: number | null;
  path: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function kindIcon(kind: FsEntryKind) {
  if (kind === "dir") return <Folder size={11} className="text-amber-400" />;
  if (kind === "symlink") return <Link2 size={11} className="text-cyan-400" />;
  return <FileText size={11} className="text-[#858585]" />;
}

function parentOf(path: string): string | null {
  if (!path || path === "/") return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return "/" + parts.slice(0, -1).join("/");
}

export function ContainerFilesView({ containerId, path, onNavigate, onOpenFile }: Props) {
  const enabled = containerId !== null && path.startsWith("/");
  const { data, error, isLoading } = useQuery<DirectoryListing>({
    queryKey: ["fs:list", containerId, path],
    queryFn: () => listContainerDirectory(containerId!, path),
    enabled,
    staleTime: 5_000,
  });

  if (containerId === null) {
    return (
      <p className="px-3 py-2 text-xs text-[#606060]">Open a container to browse its files.</p>
    );
  }
  if (!path) {
    return (
      <p className="px-3 py-2 text-xs text-[#606060]">Waiting for the container&apos;s WORKDIR…</p>
    );
  }

  const parent = parentOf(path);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-[#2b2b2b] px-3 py-1.5">
        <h3 className="text-[10px] font-semibold tracking-wider text-[#858585] uppercase">Files</h3>
        <span className="truncate font-mono text-[11px] text-[#858585]" title={path}>
          {path}
        </span>
      </header>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="px-3 py-2 text-xs text-[#858585]">Loading…</p>}
        {error && (
          <div className="px-3 py-2 text-xs text-red-400">
            <p>{error instanceof Error ? error.message : String(error)}</p>
            {error instanceof Error && /^404:/.test(error.message) && (
              <p className="mt-1 text-[10px] text-[#858585]">
                The hub doesn&apos;t know this route. It&apos;s likely running an older build —
                restart it to pick up the filesystem endpoints.
              </p>
            )}
          </div>
        )}
        {data && (
          <ul>
            {parent !== null && (
              <li>
                <button
                  type="button"
                  onClick={() => onNavigate(parent)}
                  className="flex w-full items-center gap-2 px-3 py-1 text-[11px] text-[#858585] hover:bg-[#2a2a2a] hover:text-[#c0c0c0]"
                >
                  <ArrowUp size={11} /> ..
                </button>
              </li>
            )}
            {data.entries.map((entry) => {
              const childPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    onClick={() => {
                      if (entry.kind === "dir") onNavigate(childPath);
                      else onOpenFile(childPath);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1 text-[11px] text-[#cccccc] hover:bg-[#2a2a2a]"
                    title={entry.target ? `${entry.name} → ${entry.target}` : entry.name}
                  >
                    {kindIcon(entry.kind)}
                    <span className="truncate">{entry.name}</span>
                    {entry.kind === "file" && (
                      <span className="ml-auto shrink-0 text-[10px] text-[#606060]">
                        {entry.size}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {data && data.truncated && (
          <p className="px-3 py-2 text-[10px] text-yellow-500">
            Listing truncated at 1000 entries.
          </p>
        )}
      </div>
    </div>
  );
}
