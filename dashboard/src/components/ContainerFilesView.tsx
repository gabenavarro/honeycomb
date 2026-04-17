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
import { useState } from "react";

import { listContainerDirectory } from "../lib/api";
import type { DirectoryListing, FsEntry, FsEntryKind } from "../lib/types";

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
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-[#2b2b2b] px-3 py-1.5">
        <h3 className="text-[10px] font-semibold tracking-wider text-[#858585] uppercase">Files</h3>
        <span className="truncate font-mono text-[11px] text-[#858585]" title={path}>
          {path}
        </span>
      </header>
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
  /** Starts expanded for the root node; every child starts collapsed. */
  open: boolean;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function DirectoryNode({
  containerId,
  path,
  depth,
  open: openInitial,
  onNavigate,
  onOpenFile,
}: NodeProps) {
  const [open, setOpen] = useState(openInitial);
  const { data, error, isFetching } = useQuery<DirectoryListing>({
    queryKey: ["fs:list", containerId, path],
    queryFn: () => listContainerDirectory(containerId, path),
    enabled: open,
    staleTime: 5_000,
    refetchInterval: open ? 15_000 : false,
  });

  return (
    <div>
      {open && isFetching && !data && (
        <p
          className="px-3 py-1 text-[11px] text-[#858585]"
          style={{ paddingLeft: `${12 + depth * 12}px` }}
        >
          Loading…
        </p>
      )}
      {open && error && (
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
      {open &&
        data?.entries.map((entry) => (
          <Row
            key={entry.name}
            entry={entry}
            containerId={containerId}
            parentPath={path}
            depth={depth}
            onNavigate={onNavigate}
            onOpenFile={onOpenFile}
          />
        ))}
      {open && data?.truncated && (
        <p
          className="px-3 py-1 text-[10px] text-yellow-500"
          style={{ paddingLeft: `${12 + depth * 12}px` }}
        >
          Listing truncated at 1000 entries.
        </p>
      )}
      {/* Provide a way to collapse the root; for child nodes the Row
          component owns its own expand/collapse via the chevron. */}
      {open && depth === 0 && (
        <button type="button" onClick={() => setOpen(false)} hidden aria-hidden="true" />
      )}
    </div>
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
  const [open, setOpen] = useState(false);
  const childPath = joinPath(parentPath, entry.name);
  const isDir = entry.kind === "dir";

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isDir) {
            setOpen((v) => !v);
            onNavigate(childPath);
          } else {
            onOpenFile(childPath);
          }
        }}
        className="flex w-full items-center gap-1 text-left text-[11px] text-[#cccccc] hover:bg-[#2a2a2a]"
        style={{
          paddingLeft: `${12 + depth * 12}px`,
          paddingRight: "12px",
          paddingTop: "2px",
          paddingBottom: "2px",
        }}
        title={entry.target ? `${entry.name} → ${entry.target}` : entry.name}
      >
        {isDir ? (
          open ? (
            <ChevronDown size={10} className="shrink-0 text-[#858585]" />
          ) : (
            <ChevronRight size={10} className="shrink-0 text-[#858585]" />
          )
        ) : (
          <span className="inline-block w-[10px]" aria-hidden="true" />
        )}
        {kindIcon(entry.kind)}
        <span className="truncate">{entry.name}</span>
        {entry.kind === "file" && (
          <span className="ml-auto shrink-0 text-[10px] text-[#606060]">{entry.size}</span>
        )}
      </button>
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
