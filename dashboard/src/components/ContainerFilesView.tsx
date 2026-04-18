/** Sidebar activity: files inside the active container (M17 + M21 E).
 *
 * M17 shipped a flat "click-to-navigate-into" view. M21 E upgrades it
 * to a proper tree: each directory expands in place, its children
 * lazy-load, and the breadcrumb path stays in lockstep so the editor
 * header still reflects where the user is focused.
 *
 * Design notes:
 *
 * - One ``useQuery`` per directory, keyed by (containerId, path),
 *   enabled only when the user has expanded that node. Collapse does
 *   not invalidate — reopening gets cache-hit + background refetch.
 * - Clicking a directory label toggles expansion AND syncs the
 *   Breadcrumbs path up to that dir (``onNavigate``).
 * - Clicking a file label opens the viewer (``onOpenFile``).
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ChevronDown, ChevronRight, FileText, Folder, Link2 } from "lucide-react";
import { useMemo, useState } from "react";

import { listContainerDirectory } from "../lib/api";
import type { DirectoryListing, FsEntry, FsEntryKind } from "../lib/types";

/** M22.1 — folders sort before files; both groups case-insensitive. */
function sortEntries(entries: FsEntry[]): FsEntry[] {
  const dirs: FsEntry[] = [];
  const files: FsEntry[] = [];
  for (const e of entries) (e.kind === "dir" ? dirs : files).push(e);
  const cmp = (a: FsEntry, b: FsEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  dirs.sort(cmp);
  files.sort(cmp);
  return [...dirs, ...files];
}

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

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

export function ContainerFilesView({ containerId, path, onNavigate, onOpenFile }: Props) {
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
    // M22.2 — the outer App.tsx sidebar header already labels the
    // activity and shows the path; this component stays headerless to
    // avoid a duplicate "FILES … /path" strip.
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {parent !== null && (
          <button
            type="button"
            onClick={() => onNavigate(parent)}
            className="flex w-full items-center gap-2 px-3 py-1 text-[11px] text-[#858585] hover:bg-[#2a2a2a] hover:text-[#c0c0c0]"
          >
            <ArrowUp size={11} /> ..
          </button>
        )}
        <DirectoryNode
          containerId={containerId}
          path={path}
          depth={0}
          open
          onNavigate={onNavigate}
          onOpenFile={onOpenFile}
        />
      </div>
    </div>
  );
}

interface NodeProps {
  containerId: number;
  path: string;
  depth: number;
  /** Fully controlled — whoever owns this node decides when to fetch.
   * The root passes ``open`` literal true; child ``Row``s pass their
   * own chevron state down so toggling updates the query instantly. */
  open: boolean;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function DirectoryNode({ containerId, path, depth, open, onNavigate, onOpenFile }: NodeProps) {
  const { data, error, isFetching } = useQuery<DirectoryListing>({
    queryKey: ["fs:list", containerId, path],
    queryFn: () => listContainerDirectory(containerId, path),
    enabled: open,
    staleTime: 5_000,
    refetchInterval: open ? 15_000 : false,
  });

  if (!open) return null;

  return (
    <div>
      {isFetching && !data && (
        <p
          className="px-3 py-1 text-[11px] text-[#858585]"
          style={{ paddingLeft: `${12 + depth * 12}px` }}
        >
          Loading…
        </p>
      )}
      {error && (
        <div
          className="px-3 py-1 text-[11px] text-red-400"
          style={{ paddingLeft: `${12 + depth * 12}px` }}
        >
          <p>{error instanceof Error ? error.message : String(error)}</p>
          {error instanceof Error && /^404:/.test(error.message) && (
            <p className="mt-1 text-[10px] text-[#858585]">
              Hub may be running an older build — restart it to pick up the filesystem endpoints.
            </p>
          )}
        </div>
      )}
      {data && (
        <SortedRows
          entries={data.entries}
          containerId={containerId}
          parentPath={path}
          depth={depth}
          onNavigate={onNavigate}
          onOpenFile={onOpenFile}
        />
      )}
      {data?.truncated && (
        <p
          className="px-3 py-1 text-[10px] text-yellow-500"
          style={{ paddingLeft: `${12 + depth * 12}px` }}
        >
          Listing truncated at 1000 entries.
        </p>
      )}
    </div>
  );
}

function SortedRows({
  entries,
  containerId,
  parentPath,
  depth,
  onNavigate,
  onOpenFile,
}: {
  entries: FsEntry[];
  containerId: number;
  parentPath: string;
  depth: number;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const sorted = useMemo(() => sortEntries(entries), [entries]);
  return (
    <>
      {sorted.map((entry) => (
        <Row
          key={entry.name}
          entry={entry}
          containerId={containerId}
          parentPath={parentPath}
          depth={depth}
          onNavigate={onNavigate}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  );
}

function Row({
  entry,
  containerId,
  parentPath,
  depth,
  onNavigate,
  onOpenFile,
}: {
  entry: FsEntry;
  containerId: number;
  parentPath: string;
  depth: number;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  // M22.1 — a directory row exposes two distinct gestures:
  //   chevron click    → toggle inline expansion (cheap peek)
  //   double-click name → navigate INTO the folder (new root)
  // A file row keeps single-click-to-open. Previously the whole row
  // did both expansion and navigation, which made the chevron useless.
  const [open, setOpen] = useState(false);
  const childPath = joinPath(parentPath, entry.name);
  const isDir = entry.kind === "dir";

  return (
    <div>
      <div
        className="flex items-center gap-1 text-[11px] text-[#cccccc] hover:bg-[#2a2a2a]"
        style={{
          paddingLeft: `${4 + depth * 12}px`,
          paddingRight: "12px",
          paddingTop: "2px",
          paddingBottom: "2px",
        }}
        title={
          isDir
            ? `${entry.name} — double-click to navigate into, chevron to expand in place`
            : entry.target
              ? `${entry.name} → ${entry.target}`
              : entry.name
        }
      >
        {isDir ? (
          <button
            type="button"
            onClick={(e) => {
              // Stop propagation so a parent row doesn't also toggle.
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-[#3a3a3a]"
            aria-label={open ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
          >
            {open ? (
              <ChevronDown size={10} className="text-[#858585]" />
            ) : (
              <ChevronRight size={10} className="text-[#858585]" />
            )}
          </button>
        ) : (
          <span className="inline-block h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => {
            if (!isDir) onOpenFile(childPath);
          }}
          onDoubleClick={() => {
            if (isDir) onNavigate(childPath);
          }}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0078d4] focus-visible:ring-inset"
        >
          {kindIcon(entry.kind)}
          <span className="truncate">{entry.name}</span>
          {entry.kind === "file" && (
            <span className="ml-auto shrink-0 text-[10px] text-[#606060]">{entry.size}</span>
          )}
        </button>
      </div>
      {isDir && (
        <DirectoryNode
          containerId={containerId}
          path={childPath}
          depth={depth + 1}
          open={open}
          onNavigate={onNavigate}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  );
}
