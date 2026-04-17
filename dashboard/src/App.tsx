/** Top-level layout. VSCode/Cursor-inspired:
 *   ActivityBar | PrimarySidebar | (ContainerTabs over TerminalPane) | SecondaryPanel
 *                                                                    StatusBar (bottom)
 *
 * The primary sidebar content is driven by the active Activity; only one
 * sidebar view is visible at a time so the rail stays narrow. Open
 * containers become tabs in the editor area — closing a tab just removes
 * it from the open set, it does not unregister the container. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { listContainers, listPRs } from "./lib/api";
import { ContainerList } from "./components/ContainerList";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { LocalStorageQuotaWatcher } from "./components/LocalStorageQuotaWatcher";
import { WebSocketListenerErrorWatcher } from "./components/WebSocketListenerErrorWatcher";
import { TerminalPane } from "./components/TerminalPane";
import { ResourceMonitor } from "./components/ResourceMonitor";
import { GitOpsPanel } from "./components/GitOpsPanel";
import { Provisioner } from "./components/Provisioner";
import { ActivityBar, type Activity } from "./components/ActivityBar";
import { ContainerTabs } from "./components/ContainerTabs";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { AuthGate } from "./components/AuthGate";
import { backoffRefetch } from "./hooks/useSmartPoll";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { purgeContainerSessions } from "./hooks/useSessionStore";
import type { ContainerRecord } from "./lib/types";

// Storage keys for layout state. Remembering these across reloads is
// expected behavior for an IDE-style app.
const LS_OPEN_TABS = "hive:layout:openTabs";
const LS_ACTIVE_TAB = "hive:layout:activeTab";
const LS_ACTIVITY = "hive:layout:activity";
const LS_SIDEBAR_OPEN = "hive:layout:sidebar";
const LS_SECONDARY_OPEN = "hive:layout:secondary";
const LS_LAST_KIND_PREFIX = "hive:terminal-last-kind:";

function isActivity(v: unknown): v is Activity {
  return v === "containers" || v === "gitops" || v === "settings";
}
function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === "number");
}
function isNullableNumber(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

export default function App() {
  const queryClient = useQueryClient();

  // One typed hook per persisted field — storage read + write collapsed
  // into the hook, no explicit ``useEffect`` needed.
  const [activity, setActivity] = useLocalStorage<Activity>(LS_ACTIVITY, "containers", {
    validate: isActivity,
  });
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>(LS_SIDEBAR_OPEN, true, {
    validate: isBoolean,
  });
  const [secondaryOpen, setSecondaryOpen] = useLocalStorage<boolean>(LS_SECONDARY_OPEN, true, {
    validate: isBoolean,
  });
  const [openTabs, setOpenTabs] = useLocalStorage<number[]>(LS_OPEN_TABS, [], {
    validate: isNumberArray,
  });
  const [activeTabId, setActiveTabId] = useLocalStorage<number | null>(LS_ACTIVE_TAB, null, {
    validate: isNullableNumber,
  });
  const [showProvisioner, setShowProvisioner] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const { data: containers = [] } = useQuery({
    queryKey: ["containers"],
    queryFn: listContainers,
    refetchInterval: backoffRefetch(),
  });
  const { data: prs = [] } = useQuery({
    queryKey: ["prs"],
    queryFn: () => listPRs("open"),
    refetchInterval: backoffRefetch({ baseMs: 30_000, maxMs: 300_000 }),
  });

  // Prune open tabs for containers that no longer exist (deleted on the
  // backend). Also purge their cached sessions.
  useEffect(() => {
    const known = new Set(containers.map((c) => c.id));
    const stillOpen = openTabs.filter((id) => known.has(id));
    const removed = openTabs.filter((id) => !known.has(id));
    if (removed.length > 0) {
      for (const id of removed) purgeContainerSessions(id);
      setOpenTabs(stillOpen);
      if (activeTabId !== null && !known.has(activeTabId)) {
        setActiveTabId(stillOpen[0] ?? null);
      }
    }
  }, [containers, openTabs, activeTabId]);

  const openContainers: ContainerRecord[] = useMemo(
    () =>
      openTabs
        .map((id) => containers.find((c) => c.id === id))
        .filter((c): c is ContainerRecord => Boolean(c)),
    [openTabs, containers],
  );
  const active: ContainerRecord | undefined = containers.find((c) => c.id === activeTabId);

  const openContainer = useCallback(
    (id: number) => {
      setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setActiveTabId(id);
    },
    [setOpenTabs, setActiveTabId],
  );

  const closeTab = useCallback(
    (id: number) => {
      setOpenTabs((prev) => {
        const next = prev.filter((x) => x !== id);
        // When closing the active tab, hop to the neighbor on the
        // right, then the left — same semantics as VSCode.
        setActiveTabId((current) => {
          if (current !== id) return current;
          const wasIdx = prev.indexOf(id);
          if (wasIdx === -1) return current;
          if (next.length === 0) return null;
          return next[Math.min(wasIdx, next.length - 1)];
        });
        return next;
      });
    },
    [setOpenTabs, setActiveTabId],
  );

  const newClaudeSession = useCallback(
    (id: number) => {
      // Open the container and remember that Claude is the intended
      // kind — TerminalPane reads this LS key on mount.
      localStorage.setItem(`${LS_LAST_KIND_PREFIX}${id}`, "claude");
      setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setActiveTabId(id);
    },
    [setOpenTabs, setActiveTabId],
  );

  useKeyboardShortcuts({
    onCommandPalette: () => setPaletteOpen((v) => !v),
    onToggleSidebar: () => setSidebarOpen((v) => !v),
    onToggleSecondary: () => setSecondaryOpen((v) => !v),
    onCloseActiveTab: () => {
      if (activeTabId !== null) closeTab(activeTabId);
    },
    onFocusTabByIndex: (idx) => {
      const tab = openTabs[idx];
      if (tab !== undefined) setActiveTabId(tab);
    },
    onActivityContainers: () => {
      setActivity("containers");
      setSidebarOpen(true);
    },
    onActivityGitOps: () => {
      setActivity("gitops");
      setSidebarOpen(true);
    },
  });

  const selectedUnhealthy =
    active !== undefined &&
    (active.container_status !== "running" || active.agent_status === "unreachable");
  const firstHealthy = useMemo(
    () =>
      openContainers.find(
        (c) => c.container_status === "running" && c.agent_status !== "unreachable",
      ),
    [openContainers],
  );

  return (
    <AuthGate>
      <LocalStorageQuotaWatcher />
      <WebSocketListenerErrorWatcher />
      <div className="flex h-screen flex-col bg-[#1e1e1e] text-[#cccccc]">
        <div className="flex min-h-0 flex-1">
          <ActivityBar
            active={activity}
            onChange={(a) => {
              setActivity(a);
              setSidebarOpen(true);
            }}
            containerCount={containers.length}
            prCount={prs.length}
            onOpenCommandPalette={() => setPaletteOpen(true)}
          />

          {sidebarOpen && (
            <aside
              aria-label="Primary sidebar"
              className="flex w-72 shrink-0 flex-col border-r border-[#2b2b2b] bg-[#1e1e1e]"
            >
              <header className="flex items-center justify-between border-b border-[#2b2b2b] px-3 py-1.5">
                <h2 className="text-[10px] font-semibold tracking-wider text-[#858585] uppercase">
                  {activity === "containers"
                    ? "Containers"
                    : activity === "gitops"
                      ? "Git Ops"
                      : "Settings"}
                </h2>
                {activity === "containers" && (
                  <button
                    type="button"
                    onClick={() => setShowProvisioner(true)}
                    className="rounded bg-[#0078d4] px-2 py-0.5 text-[10px] font-medium text-white hover:bg-[#1188e0]"
                  >
                    + New
                  </button>
                )}
              </header>
              <div className="flex-1 overflow-y-auto">
                {activity === "containers" && (
                  <ContainerList selectedId={activeTabId} onSelect={openContainer} />
                )}
                {activity === "gitops" && <GitOpsPanel />}
                {activity === "settings" && <SettingsPane />}
              </div>
            </aside>
          )}

          {/* Editor area: tabs + active pane */}
          <main className="flex min-w-0 flex-1 flex-col bg-[#1e1e1e]">
            <ContainerTabs
              openContainers={openContainers}
              activeId={activeTabId}
              onFocus={setActiveTabId}
              onClose={closeTab}
            />
            {active ? (
              <div className="flex min-h-0 flex-1 flex-col">
                {selectedUnhealthy && (
                  <div
                    role="alert"
                    className="flex items-center justify-between gap-3 border-b border-yellow-800/50 bg-yellow-900/20 px-3 py-1 text-[11px] text-yellow-300"
                  >
                    <span className="flex items-center gap-2">
                      <AlertTriangle size={11} />
                      {active.project_name} is{" "}
                      {active.container_status !== "running"
                        ? active.container_status
                        : "unreachable"}
                      .
                    </span>
                    {firstHealthy && firstHealthy.id !== active.id && (
                      <button
                        type="button"
                        onClick={() => setActiveTabId(firstHealthy.id)}
                        className="rounded bg-yellow-800/40 px-2 py-0.5 hover:bg-yellow-700/40"
                      >
                        Switch to {firstHealthy.project_name}
                      </button>
                    )}
                  </div>
                )}
                <div className="flex min-h-0 min-w-0 flex-1 p-2">
                  {/* ErrorBoundary keyed on active.id so remounting the
                      child when the user switches tabs also clears any
                      stuck error state from the previous container. */}
                  <ErrorBoundary
                    key={`eb-${active.id}`}
                    label={`the ${active.project_name} terminal`}
                  >
                    <TerminalPane
                      key={active.id}
                      containerId={active.id}
                      containerName={active.project_name}
                      hasClaudeCli={active.has_claude_cli}
                    />
                  </ErrorBoundary>
                </div>
              </div>
            ) : (
              <EmptyEditor
                onOpenProvisioner={() => setShowProvisioner(true)}
                hasRegistered={containers.length > 0}
              />
            )}
          </main>

          {secondaryOpen && active && (
            <aside
              aria-label="Secondary panel"
              className="w-64 shrink-0 overflow-y-auto border-l border-[#2b2b2b] bg-[#1e1e1e] p-3"
            >
              <h2 className="mb-2 text-[10px] font-semibold tracking-wider text-[#858585] uppercase">
                Resources
              </h2>
              <ResourceMonitor containerId={active.id} />
            </aside>
          )}
        </div>

        <StatusBar activeContainerName={active?.project_name ?? null} />

        {showProvisioner && <Provisioner onClose={() => setShowProvisioner(false)} />}

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          containers={containers}
          onFocusContainer={openContainer}
          onCloseContainer={closeTab}
          onNewClaudeSession={newClaudeSession}
          onActivity={(a) => {
            setActivity(a);
            setSidebarOpen(true);
          }}
          onOpenProvisioner={() => setShowProvisioner(true)}
        />
      </div>
    </AuthGate>
  );

  // Reference queryClient so the import isn't pruned and so children can
  // invalidate through it.
  void queryClient;
}

function EmptyEditor({
  onOpenProvisioner,
  hasRegistered,
}: {
  onOpenProvisioner: () => void;
  hasRegistered: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm text-[#858585]">
        {hasRegistered
          ? "Open a container from the sidebar to start a session."
          : "No containers registered yet."}
      </p>
      <p className="text-[11px] text-[#606060]">
        Press <kbd className="rounded border border-[#444] px-1.5 py-0.5">Ctrl+K</kbd> for the
        command palette · <kbd className="rounded border border-[#444] px-1.5 py-0.5">Ctrl+B</kbd>{" "}
        to toggle the sidebar.
      </p>
      <button
        type="button"
        onClick={onOpenProvisioner}
        className="mt-2 rounded bg-[#0078d4] px-3 py-1.5 text-xs text-white hover:bg-[#1188e0]"
      >
        Discover &amp; register a container
      </button>
    </div>
  );
}

function SettingsPane() {
  return (
    <div className="p-4 text-xs text-[#858585]">
      <p>Settings view — coming soon.</p>
      <p className="mt-2 text-[11px]">
        For now, use <code className="text-[#c0c0c0]">HIVE_*</code> env vars and edit{" "}
        <code className="text-[#c0c0c0]">settings.json</code> directly.
      </p>
    </div>
  );
}
