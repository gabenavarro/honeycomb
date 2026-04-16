import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch,
  GitPullRequest,
  ExternalLink,
  Check,
  GitMerge,
  MessageSquare,
} from "lucide-react";
import { listRepos, listPRs, mergePR, reviewPR } from "../lib/api";
import type { PullRequestSummary, RepoStatus } from "../lib/types";
import { backoffRefetch } from "../hooks/useSmartPoll";
import { useToasts } from "../hooks/useToasts";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function RepoRow({ repo }: { repo: RepoStatus }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs hover:bg-gray-800/50">
      <div className="flex items-center gap-2">
        <GitBranch size={12} className="text-gray-600" />
        <span className="font-medium text-gray-300">{repo.workspace_folder.split("/").pop()}</span>
        <span className="text-gray-600">{repo.branch}</span>
      </div>
      <div className="flex items-center gap-3 text-[11px]">
        {repo.dirty && <span className="text-yellow-500">modified</span>}
        {!repo.has_upstream ? (
          <span className="text-gray-500 italic" title="Branch has no upstream configured">
            no upstream
          </span>
        ) : (
          <>
            {repo.ahead > 0 && <span className="text-green-400">+{repo.ahead}</span>}
            {repo.behind > 0 && <span className="text-red-400">-{repo.behind}</span>}
          </>
        )}
        {repo.open_pr_count > 0 && (
          <span className="flex items-center gap-1 text-purple-400">
            <GitPullRequest size={10} />
            {repo.open_pr_count}
          </span>
        )}
      </div>
    </div>
  );
}

function parseRepo(repoFull: string): { owner: string; repo: string } | null {
  const parts = repoFull.split("/");
  if (parts.length < 2) return null;
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

function PRRow({ pr }: { pr: PullRequestSummary }) {
  const { toast } = useToasts();
  const queryClient = useQueryClient();
  const parsed = parseRepo(pr.repo);

  const statusColor =
    pr.review_status === "APPROVED"
      ? "text-green-400"
      : pr.review_status === "CHANGES_REQUESTED"
        ? "text-red-400"
        : "text-gray-400";

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["prs"] });

  const approveMut = useMutation({
    mutationFn: () => {
      if (!parsed) throw new Error(`Cannot parse repo: ${pr.repo}`);
      return reviewPR(parsed.owner, parsed.repo, pr.number, "approve");
    },
    onSuccess: () => {
      toast("success", `Approved #${pr.number}`);
      invalidate();
    },
  });

  const mergeMut = useMutation({
    mutationFn: () => {
      if (!parsed) throw new Error(`Cannot parse repo: ${pr.repo}`);
      return mergePR(parsed.owner, parsed.repo, pr.number, "squash", true);
    },
    onSuccess: () => {
      toast("success", `Merged #${pr.number}`, "Branch deleted (squash).");
      invalidate();
    },
  });

  const commentMut = useMutation({
    mutationFn: (body: string) => {
      if (!parsed) throw new Error(`Cannot parse repo: ${pr.repo}`);
      return reviewPR(parsed.owner, parsed.repo, pr.number, "comment", body);
    },
    onSuccess: () => {
      toast("success", `Comment added to #${pr.number}`);
      invalidate();
    },
  });

  const busy = approveMut.isPending || mergeMut.isPending || commentMut.isPending;

  const confirmMerge = () => {
    if (!window.confirm(`Squash and merge #${pr.number}? This will delete the source branch.`)) {
      return;
    }
    mergeMut.mutate();
  };

  const addComment = () => {
    const body = window.prompt(`Comment on #${pr.number}:`);
    if (body && body.trim()) commentMut.mutate(body.trim());
  };

  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs hover:bg-gray-800/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <GitPullRequest size={12} className="shrink-0 text-purple-400" />
          <span className="truncate font-medium text-gray-300">{pr.title}</span>
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-gray-600 hover:text-blue-400"
            onClick={(e) => e.stopPropagation()}
            aria-label="Open PR on GitHub"
          >
            <ExternalLink size={10} />
          </a>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-600">
          <span>{pr.repo}</span>
          <span>#{pr.number}</span>
          <span>{pr.author}</span>
          <span>{timeAgo(pr.updated_at)}</span>
        </div>
      </div>
      <div className="flex items-center gap-3 text-[11px]">
        <span className="text-green-500">+{pr.additions}</span>
        <span className="text-red-400">-{pr.deletions}</span>
        <span className={statusColor}>{pr.review_status || "pending"}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => approveMut.mutate()}
            disabled={busy || !parsed}
            className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-green-400 disabled:opacity-30"
            title="Approve"
            aria-label={`Approve PR #${pr.number}`}
          >
            <Check size={12} />
          </button>
          <button
            type="button"
            onClick={addComment}
            disabled={busy || !parsed}
            className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-blue-400 disabled:opacity-30"
            title="Comment"
            aria-label={`Comment on PR #${pr.number}`}
          >
            <MessageSquare size={12} />
          </button>
          <button
            type="button"
            onClick={confirmMerge}
            disabled={busy || !parsed}
            className="rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-purple-400 disabled:opacity-30"
            title="Squash & merge"
            aria-label={`Squash and merge PR #${pr.number}`}
          >
            <GitMerge size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function GitOpsPanel() {
  const { data: repos = [] } = useQuery({
    queryKey: ["repos"],
    queryFn: listRepos,
    refetchInterval: backoffRefetch({ baseMs: 30_000, maxMs: 300_000 }),
  });

  const { data: prs = [] } = useQuery({
    queryKey: ["prs"],
    queryFn: () => listPRs("open"),
    refetchInterval: backoffRefetch({ baseMs: 30_000, maxMs: 300_000 }),
  });

  return (
    <div className="flex h-full flex-col">
      {/* Repos */}
      <div className="border-b border-gray-800">
        <h3 className="px-3 py-2 text-xs font-medium tracking-wider text-gray-500 uppercase">
          Repositories ({repos.length})
        </h3>
        <div className="max-h-48 divide-y divide-gray-800/50 overflow-y-auto">
          {repos.map((r: RepoStatus) => (
            <RepoRow key={r.workspace_folder} repo={r} />
          ))}
          {repos.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-600">No repos registered</p>
          )}
        </div>
      </div>

      {/* Pull Requests */}
      <div className="flex-1 overflow-hidden">
        <h3 className="px-3 py-2 text-xs font-medium tracking-wider text-gray-500 uppercase">
          Pull Requests ({prs.length})
        </h3>
        <div className="h-full divide-y divide-gray-800/50 overflow-y-auto">
          {prs.map((pr: PullRequestSummary) => (
            <PRRow key={`${pr.repo}-${pr.number}`} pr={pr} />
          ))}
          {prs.length === 0 && <p className="px-3 py-2 text-xs text-gray-600">No open PRs</p>}
        </div>
      </div>
    </div>
  );
}
