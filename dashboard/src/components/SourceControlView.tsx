/** Source Control view (M10).
 *
 * For every registered repo the hub knows about, show a compact tree
 * of its git status: staged files, modified files, untracked files.
 * This reuses the existing ``/api/gitops/repos`` endpoint for the repo
 * list and adds a lazy ``/api/gitops/status/{workspace_folder}`` fetch
 * when the user expands a repo.
 */

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, File, FilePlus, GitBranch } from "lucide-react";
import { useState } from "react";

import { getRepoFileStatus, listRepos } from "../lib/api";
import type { GitFileStatus, RepoStatus } from "../lib/types";

function Section({
  label,
  files,
  icon,
}: {
  label: string;
  files: string[];
  icon: React.ReactNode;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="px-4 py-0.5 text-[10px] font-semibold tracking-wider text-[#858585] uppercase">
        {label} ({files.length})
      </div>
      <ul>
        {files.map((f) => (
          <li
            key={f}
            className="flex items-center gap-1.5 px-6 py-0.5 text-[11px] text-[#cccccc] hover:bg-[#2a2a2a]"
            title={f}
          >
            {icon}
            <span className="truncate">{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RepoBlock({ repo }: { repo: RepoStatus }) {
  const [open, setOpen] = useState(false);
  const { data, isFetching } = useQuery<GitFileStatus>({
    queryKey: ["gitops", "status", repo.workspace_folder],
    queryFn: () => getRepoFileStatus(repo.workspace_folder),
    enabled: open,
    // Keep it fresh but don't thrash — the view is rarely looked at
    // for long stretches.
    refetchInterval: open ? 15_000 : false,
  });

  const dirtyCount = repo.staged_count + repo.modified_count + repo.untracked_count;

  return (
    <div className="border-b border-[#2b2b2b]/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] hover:bg-[#2a2a2a]"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <GitBranch size={12} className="text-[#858585]" />
        <span className="truncate font-medium text-[#e7e7e7]">
          {repo.workspace_folder.split("/").pop()}
        </span>
        <span className="text-[10px] text-[#858585]">{repo.branch}</span>
        <span className="ml-auto text-[10px] text-[#858585]">
          {dirtyCount > 0 ? `${dirtyCount} changed` : "clean"}
        </span>
      </button>
      {open && (
        <div className="pb-2">
          {isFetching && !data && <p className="px-4 py-1 text-[11px] text-[#858585]">Loading…</p>}
          {data && (
            <>
              <Section
                label="Staged"
                files={data.staged}
                icon={<File size={10} className="text-green-400" />}
              />
              <Section
                label="Changes"
                files={data.modified}
                icon={<File size={10} className="text-yellow-400" />}
              />
              <Section
                label="Untracked"
                files={data.untracked}
                icon={<FilePlus size={10} className="text-blue-400" />}
              />
              {data.staged.length === 0 &&
                data.modified.length === 0 &&
                data.untracked.length === 0 && (
                  <p className="px-4 py-1 text-[11px] text-[#606060]">Working tree clean.</p>
                )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function SourceControlView() {
  const { data: repos = [], isLoading } = useQuery({
    queryKey: ["repos"],
    queryFn: listRepos,
  });

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[#2b2b2b] px-3 py-1.5">
        <h3 className="text-[10px] font-semibold tracking-wider text-[#858585] uppercase">
          Source Control ({repos.length})
        </h3>
      </header>
      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="px-3 py-2 text-xs text-[#858585]">Scanning repos…</p>}
        {!isLoading && repos.length === 0 && (
          <p className="px-3 py-2 text-xs text-[#606060]">
            No repos registered. Register a devcontainer to see its git status here.
          </p>
        )}
        {repos.map((r) => (
          <RepoBlock key={r.workspace_folder} repo={r} />
        ))}
      </div>
    </div>
  );
}
