import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Search, Edit3, Folder, Box, Zap, RefreshCw, Check } from "lucide-react";
import { createContainer, registerDiscovered } from "../lib/api";
import type { ContainerCandidate, ProjectType, WorkspaceCandidate, WSFrame } from "../lib/types";
import { useHiveWebSocket } from "../hooks/useWebSocket";
import { useDiscovery } from "../hooks/useDiscovery";
import { useToasts } from "../hooks/useToasts";

const projectTypes: { value: ProjectType; label: string; desc: string }[] = [
  { value: "base", label: "Base", desc: "General-purpose development" },
  { value: "ml-cuda", label: "ML/CUDA", desc: "PyTorch, HuggingFace, Lightning + GPU" },
  { value: "web-dev", label: "Web Dev", desc: "Node.js, FastAPI, React" },
  { value: "compbio", label: "CompBio", desc: "Bioinformatics, single-cell, protein modeling" },
];

interface Props {
  onClose: () => void;
}

type Tab = "discover" | "manual";

// When the user clicks a candidate on the Discover tab we copy its
// fields into this shape and flip to the Manual tab (or auto-submit,
// depending on the candidate kind).
interface Prefill {
  workspace_folder: string;
  project_name: string;
  project_type: ProjectType;
  // Only present when registering an already-running container.
  container_id?: string;
  // Only visible to the user as a descriptive detail, not submitted.
  source_label: string;
}

export function Provisioner({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("discover");
  const [prefill, setPrefill] = useState<Prefill | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-2xl rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
        {/* Tab bar */}
        <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2">
          <div className="flex gap-1">
            <TabButton
              active={tab === "discover"}
              onClick={() => setTab("discover")}
              icon={<Search size={12} />}
              label="Discover"
            />
            <TabButton
              active={tab === "manual"}
              onClick={() => setTab("manual")}
              icon={<Edit3 size={12} />}
              label="Manual"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-800 hover:text-gray-300"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        {tab === "discover" ? (
          <DiscoverTab
            onClose={onClose}
            onPickWorkspace={(ws) => {
              setPrefill({
                workspace_folder: ws.workspace_folder,
                project_name: ws.project_name,
                project_type: ws.inferred_project_type,
                source_label: `Workspace: ${ws.workspace_folder}`,
              });
              setTab("manual");
            }}
          />
        ) : (
          <ManualTab onClose={onClose} prefill={prefill} onClearPrefill={() => setPrefill(null)} />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded px-3 py-1 text-xs ${
        active
          ? "bg-gray-800 text-gray-200"
          : "text-gray-500 hover:bg-gray-800/50 hover:text-gray-300"
      }`}
      aria-pressed={active}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Discover tab ─────────────────────────────────────────────────────

function DiscoverTab({
  onClose,
  onPickWorkspace,
}: {
  onClose: () => void;
  onPickWorkspace: (ws: WorkspaceCandidate) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToasts();
  const {
    containers,
    workspaces,
    discoverRoots,
    totalCandidates,
    isLoading,
    isFetching,
    error,
    lastUpdated,
    refetch,
  } = useDiscovery();

  const registerMut = useMutation({
    mutationFn: registerDiscovered,
    onSuccess: (record) => {
      toast("success", `Registered ${record.project_name}`);
      queryClient.invalidateQueries({ queryKey: ["containers"] });
      queryClient.invalidateQueries({ queryKey: ["discover"] });
      onClose();
    },
  });

  const lastUpdatedStr = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString([], { hour12: false })
    : "";

  return (
    <div className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-200">Discover DevContainers</h2>
          <p className="mt-0.5 text-[11px] text-gray-500">
            Scanning{" "}
            <span className="font-mono text-gray-400">
              {discoverRoots.length > 0 ? discoverRoots.join(", ") : "(no roots)"}
            </span>{" "}
            and Docker · updated {lastUpdatedStr || "…"}
          </p>
        </div>
        <button
          type="button"
          onClick={refetch}
          className="rounded p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
          aria-label="Refresh discovery"
          title="Refresh"
        >
          <RefreshCw size={14} className={isFetching ? "animate-spin" : undefined} />
        </button>
      </div>

      {isLoading && <p className="py-6 text-center text-xs text-gray-500">Scanning…</p>}

      {!isLoading && error && (
        <p className="py-6 text-center text-xs text-red-400">Discovery failed: {error.message}</p>
      )}

      {!isLoading && !error && totalCandidates === 0 && (
        <EmptyDiscover
          hasRoots={discoverRoots.length > 0}
          onManual={onClose /* user can click Manual tab instead */}
        />
      )}

      {containers.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-2 text-[10px] font-semibold tracking-wider text-gray-500 uppercase">
            Running containers ({containers.length})
          </h3>
          <ul className="divide-y divide-gray-800/50 rounded border border-gray-800">
            {containers.map((c) => (
              <ContainerCandidateRow
                key={c.container_id}
                candidate={c}
                busy={registerMut.isPending}
                onRegister={() =>
                  registerMut.mutate({
                    container_id: c.container_id,
                    workspace_folder: c.inferred_workspace_folder ?? undefined,
                    project_name: c.inferred_project_name,
                    project_type: c.inferred_project_type,
                    project_description: `Discovered container ${c.container_id}`,
                    auto_provision: false,
                    auto_start: false,
                  })
                }
              />
            ))}
          </ul>
        </section>
      )}

      {workspaces.length > 0 && (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold tracking-wider text-gray-500 uppercase">
            Workspaces ready to register ({workspaces.length})
          </h3>
          <ul className="divide-y divide-gray-800/50 rounded border border-gray-800">
            {workspaces.map((w) => (
              <WorkspaceCandidateRow
                key={w.workspace_folder}
                candidate={w}
                busy={registerMut.isPending}
                onQuickAdd={() =>
                  registerMut.mutate({
                    workspace_folder: w.workspace_folder,
                    project_name: w.project_name,
                    project_type: w.inferred_project_type,
                    project_description: "",
                    auto_provision: false,
                    auto_start: false,
                  })
                }
                onCustomize={() => onPickWorkspace(w)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ContainerCandidateRow({
  candidate,
  busy,
  onRegister,
}: {
  candidate: ContainerCandidate;
  busy: boolean;
  onRegister: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Box size={12} className="shrink-0 text-blue-400" />
          <span className="truncate font-medium text-gray-200">
            {candidate.inferred_project_name}
          </span>
          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
            {candidate.inferred_project_type}
          </span>
          {candidate.has_hive_agent && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-green-900/40 px-1.5 py-0.5 text-[10px] text-green-400"
              title="hive-agent responding on :9100"
            >
              <Zap size={8} />
              agent
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-[11px] text-gray-600">
          <span className="font-mono">{candidate.container_id}</span> ·{" "}
          <span>{candidate.image || "(no tag)"}</span>
          {candidate.inferred_workspace_folder && (
            <>
              {" "}
              · <span className="font-mono">{candidate.inferred_workspace_folder}</span>
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onRegister}
        disabled={busy}
        className="flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-[11px] text-white hover:bg-blue-500 disabled:opacity-40"
      >
        <Plus size={10} /> Register
      </button>
    </li>
  );
}

function WorkspaceCandidateRow({
  candidate,
  busy,
  onQuickAdd,
  onCustomize,
}: {
  candidate: WorkspaceCandidate;
  busy: boolean;
  onQuickAdd: () => void;
  onCustomize: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Folder size={12} className="shrink-0 text-amber-400" />
          <span className="truncate font-medium text-gray-200">{candidate.project_name}</span>
          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
            {candidate.inferred_project_type}
          </span>
          {candidate.has_claude_md && (
            <span
              className="rounded bg-purple-900/40 px-1.5 py-0.5 text-[10px] text-purple-300"
              title="Workspace already has CLAUDE.md"
            >
              CLAUDE.md
            </span>
          )}
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-gray-600">
          {candidate.workspace_folder}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onCustomize}
          disabled={busy}
          className="rounded px-2 py-1 text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200 disabled:opacity-40"
          title="Prefill Manual form for tweaks before registering"
        >
          Customize…
        </button>
        <button
          type="button"
          onClick={onQuickAdd}
          disabled={busy}
          className="flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-[11px] text-white hover:bg-blue-500 disabled:opacity-40"
        >
          <Plus size={10} /> Add
        </button>
      </div>
    </li>
  );
}

function EmptyDiscover({ hasRoots, onManual }: { hasRoots: boolean; onManual: () => void }) {
  return (
    <div className="rounded border border-gray-800 bg-gray-950/50 p-6 text-center">
      <p className="text-sm text-gray-400">
        {hasRoots
          ? "No unregistered workspaces or containers found."
          : "No discovery roots configured."}
      </p>
      <p className="mt-2 text-[11px] text-gray-600">
        {hasRoots
          ? "Add a .devcontainer/devcontainer.json to a project under your configured roots, or start a devcontainer with Docker — it'll show up here."
          : "Set HIVE_DISCOVER_ROOTS=~/repos (or similar) and restart the hub."}
      </p>
      <button
        type="button"
        onClick={onManual}
        className="mt-3 text-[11px] text-blue-400 hover:underline"
      >
        Or register manually →
      </button>
    </div>
  );
}

// ─── Manual tab ───────────────────────────────────────────────────────

function ManualTab({
  onClose,
  prefill,
  onClearPrefill,
}: {
  onClose: () => void;
  prefill: Prefill | null;
  onClearPrefill: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(prefill?.project_name ?? "");
  const [workspace, setWorkspace] = useState(prefill?.workspace_folder ?? "");
  const [description, setDescription] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>(prefill?.project_type ?? "base");
  const [repoUrl, setRepoUrl] = useState("");
  const [buildLines, setBuildLines] = useState<string[]>([]);
  const [buildChannel, setBuildChannel] = useState<string | null>(null);

  // If the Discover tab prefills while this component is already mounted,
  // sync state. We key off the source_label so pressing Customize on the
  // same row twice still refreshes (e.g. user edited a field).
  const prefillSignature = useMemo(() => prefill?.source_label ?? null, [prefill]);
  const lastSignature = useRef<string | null>(null);
  useEffect(() => {
    if (prefillSignature && prefillSignature !== lastSignature.current) {
      setName(prefill!.project_name);
      setWorkspace(prefill!.workspace_folder);
      setProjectType(prefill!.project_type);
      lastSignature.current = prefillSignature;
    }
  }, [prefillSignature, prefill]);

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const createMut = useMutation({
    mutationFn: createContainer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["containers"] });
      queryClient.invalidateQueries({ queryKey: ["discover"] });
      onClose();
    },
  });

  const { subscribe, unsubscribe, onChannel } = useHiveWebSocket();

  useEffect(() => {
    if (!buildChannel) return;
    subscribe([buildChannel]);
    const off = onChannel(buildChannel, (frame: WSFrame) => {
      const data = frame.data as { stream: string; text: string };
      if (!data?.text) return;
      setBuildLines((prev) => [...prev, data.text.replace(/\n$/, "")].slice(-200));
    });
    return () => {
      off();
      unsubscribe([buildChannel]);
    };
  }, [buildChannel, subscribe, unsubscribe, onChannel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setBuildLines([]);
    setBuildChannel(`build:${workspace}`);
    createMut.mutate({
      workspace_folder: workspace,
      project_type: projectType,
      project_name: name,
      project_description: description,
      git_repo_url: repoUrl || undefined,
      auto_provision: true,
      auto_start: true,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="p-5">
      {prefill && (
        <div className="mb-3 flex items-center justify-between rounded border border-blue-500/30 bg-blue-500/5 px-3 py-1.5 text-[11px] text-blue-300">
          <span className="flex items-center gap-1.5">
            <Check size={12} /> Prefilled from: {prefill.source_label}
          </span>
          <button type="button" onClick={onClearPrefill} className="text-blue-400 hover:underline">
            clear
          </button>
        </div>
      )}

      <label className="mb-3 block">
        <span className="mb-1 block text-xs text-gray-500">Project Name</span>
        <input
          ref={nameRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          disabled={createMut.isPending}
          className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="My ML Project"
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs text-gray-500">Workspace Folder (host path)</span>
        <input
          type="text"
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          required
          disabled={createMut.isPending}
          className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="/home/user/projects/my-project"
        />
      </label>

      <fieldset className="mb-3" disabled={createMut.isPending}>
        <legend className="mb-1 text-xs text-gray-500">Project Type</legend>
        <div className="grid grid-cols-2 gap-2">
          {projectTypes.map((pt) => (
            <button
              key={pt.value}
              type="button"
              onClick={() => setProjectType(pt.value)}
              className={`rounded border px-3 py-2 text-left text-xs transition-colors ${
                projectType === pt.value
                  ? "border-blue-500 bg-blue-500/10 text-blue-400"
                  : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
              } disabled:opacity-60`}
            >
              <div className="font-medium">{pt.label}</div>
              <div className="mt-0.5 text-[10px] text-gray-600">{pt.desc}</div>
            </button>
          ))}
        </div>
      </fieldset>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs text-gray-500">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          disabled={createMut.isPending}
          className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="Brief description of what this project does..."
        />
      </label>

      <label className="mb-4 block">
        <span className="mb-1 block text-xs text-gray-500">GitHub Repo URL (optional)</span>
        <input
          type="text"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          disabled={createMut.isPending}
          className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="https://github.com/user/repo"
        />
      </label>

      {createMut.isPending && <BuildingIndicator lines={buildLines} />}

      {createMut.isError && (
        <div className="mb-3 rounded border border-red-800 bg-red-950/40 p-2 text-xs text-red-300">
          <p className="font-medium">Provision failed</p>
          <p className="mt-0.5 text-red-400/80">{createMut.error.message}</p>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={createMut.isPending}
          className="rounded px-4 py-2 text-xs text-gray-400 hover:bg-gray-800 disabled:opacity-30"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={createMut.isPending || !name || !workspace}
          className="flex items-center gap-1 rounded bg-blue-600 px-4 py-2 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {createMut.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Plus size={12} />
          )}
          {createMut.isPending ? "Building..." : createMut.isError ? "Retry" : "Create"}
        </button>
      </div>
    </form>
  );
}

function BuildingIndicator({ lines }: { lines: string[] }) {
  const [elapsed, setElapsed] = useState(0);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const clockTimer = setInterval(() => setElapsed((p) => p + 1), 1000);
    return () => clearInterval(clockTimer);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [lines]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  const latest = lines[lines.length - 1] ?? "Waiting for build output...";

  return (
    <div className="mb-4 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
      <div className="flex items-center gap-3">
        <Loader2 size={18} className="shrink-0 animate-spin text-blue-400" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-blue-300">Building DevContainer</p>
          <p className="mt-0.5 truncate text-[11px] text-blue-400/70">{latest}</p>
        </div>
        <span className="shrink-0 text-[11px] text-gray-500 tabular-nums">{timeStr}</span>
      </div>
      <pre
        ref={logRef}
        className="mt-3 max-h-48 overflow-y-auto rounded bg-black/50 p-2 text-[10px] leading-4 text-gray-400"
        aria-label="Build output"
      >
        {lines.length === 0 ? "(waiting)" : lines.join("\n")}
      </pre>
    </div>
  );
}
