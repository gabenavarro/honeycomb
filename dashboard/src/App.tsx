/** Top-level layout. VSCode/Cursor-inspired:
 *   ActivityBar | PrimarySidebar | (ContainerTabs over editor pane) | SecondaryPanel
 *                                                                    StatusBar (bottom)
 *
 * The primary sidebar content is driven by the active Activity; only one
 * sidebar view is visible at a time so the rail stays narrow. Open
 * containers become tabs in the editor area — closing a tab just removes
 * it from the open set, it does not unregister the container. M10 adds
 * Problems, Source Control, Settings, and Keybindings activities plus an
 * optional split-editor layout via ``react-resizable-panels``.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Columns } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Group,
  type Layout,
  Panel,
  type PanelImperativeHandle,
  Separator,
} from "react-resizable-panels";

import { ActivityBar, type Activity } from "./components/ActivityBar";
import { AuthGate } from "./components/AuthGate";
import { CommandPalette } from "./components/CommandPalette";
import { ContainerList } from "./components/ContainerList";
import { ContainerTabs } from "./components/ContainerTabs";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GitOpsPanel } from "./components/GitOpsPanel";
import { KeybindingsEditor } from "./components/KeybindingsEditor";
import { LocalStorageQuotaWatcher } from "./components/LocalStorageQuotaWatcher";
import { ProblemsPanel } from "./components/ProblemsPanel";
import { Provisioner } from "./components/Provisioner";
import { ResourceMonitor } from "./components/ResourceMonitor";
import { SettingsView } from "./components/SettingsView";
import { SourceControlView } from "./components/SourceControlView";
import { SplitEditor } from "./components/SplitEditor";
import { StatusBar } from "./components/StatusBar";
import { TerminalPane } from "./components/TerminalPane";
import { WebSocketListenerErrorWatcher } from "./components/WebSocketListenerErrorWatcher";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { purgeContainerSessions } from "./hooks/useSessionStore";
import { backoffRefetch } from "./hooks/useSmartPoll";
import { listContainers, listPRs, listProblems } from "./lib/api";
import type { ContainerRecord } from "./lib/types";

// Storage keys for layout state. Remembering these across reloads is
// expected behavior for an IDE-style app.
const LS_OPEN_TABS = "hive:layout:openTabs";
const LS_ACTIVE_TAB = "hive:layout:activeTab";
const LS_ACTIVITY = "hive:layout:activity";
const LS_SIDEBAR_OPEN = "hive:layout:sidebar";
const LS_SECONDARY_OPEN = "hive:layout:secondary";
const LS_SPLIT_ID = "hive:layout:splitId";
const LS_ROOT_LAYOUT = "hive:layout:rootPanels";
const LS_LAST_KIND_PREFIX = "hive:terminal-last-kind:";

const ACTIVITY_VALUES: Activity[] = [
  "containers",
  "gitops",
  "problems",
  "scm",
  "search",
  "settings",
  "keybindings",
];

function isActivity(v: unknown): v is Activity {
  return typeof v === "string" && (ACTIVITY_VALUES as string[]).includes(v);
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
function isLayout(v: unknown): v is Layout {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((n) => typeof n === "number")
  );
}

const DEFAULT_ROOT_LAYOUT: Layout = {
  "hive-sidebar": 20,
  "hive-editor": 60,
  "hive-secondary": 0,
};

export default function App() {
  const queryClient = useQueryClient();

  const [activity, setActivity] = useLocalStorage<Activity>(LS_ACTIVITY, "containers", {
    validate: isActivity,
  });
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>(LS_SIDEBAR_OPEN, true, {
    validate: isBoolean,
  });
  // M13: the default for the secondary "Resources" pane flipped to
  // *closed* because the headline numbers now live in the StatusBar
  // pill. Users who still want the always-visible bar chart can toggle
  // it back with Ctrl+` (it persists here per-user).
  const [secondaryOpen, setSecondaryOpen] = useLocalStorage<boolean>(LS_SECONDARY_OPEN, false, {
    validate: isBoolean,
  });
  const [openTabs, setOpenTabs] = useLocalStorage<number[]>(LS_OPEN_TABS, [], {
    validate: isNumberArray,
  });
  const [activeTabId, setActiveTabId] = useLocalStorage<number | null>(LS_ACTIVE_TAB, null, {
    validate: isNullableNumber,
  });
  const [splitId, setSplitId] = useLocalStorage<number | null>(LS_SPLIT_ID, null, {
    validate: isNullableNumber,
  });
  const [showProvisioner, setShowProvisioner] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const { data: containers = [], isSuccess: containersLoaded } = useQuery({
    queryKey: ["containers"],
    queryFn: listContainers,
    refetchInterval: backoffRefetch(),
  });
  const { data: prs = [] } = useQuery({
    queryKey: ["prs"],
    queryFn: () => listPRs("open"),
    refetchInterval: backoffRefetch({ baseMs: 30_000, maxMs: 300_000 }),
  });
  const { data: problemsData } = useQuery({
    queryKey: ["problems"],
    queryFn: listProblems,
    // Long stale — the live feed comes from the problems WS channel.
    staleTime: 60_000,
  });
  const problemCount = problemsData?.problems.length ?? 0;

  // Prune open tabs for containers that no longer exist (deleted on the
  // backend). Also purge their cached sessions.
  //
  // Gated on ``containersLoaded`` so the effect doesn't fire before the
  // first ``/api/containers`` response lands. Without this guard, the
  // initial render sees ``containers=[]`` (useQuery's default) and
  // evicts every persisted tab, which means a slow hub makes the user
  // lose their layout between reload and the first successful fetch.
  useEffect(() => {
    if (!containersLoaded) return;
    const known = new Set(containers.map((c) => c.id));
    const stillOpen = openTabs.filter((id) => known.has(id));
    const removed = openTabs.filter((id) => !known.has(id));
    if (removed.length > 0) {
      for (const id of removed) purgeContainerSessions(id);
      setOpenTabs(stillOpen);
      if (activeTabId !== null && !known.has(activeTabId)) {
        setActiveTabId(stillOpen[0] ?? null);
      }
      if (splitId !== null && !known.has(splitId)) {
        setSplitId(null);
      }
    }
  }, [
    containersLoaded,
    containers,
    openTabs,
    activeTabId,
    splitId,
    setOpenTabs,
    setActiveTabId,
    setSplitId,
  ]);

  const openContainers: ContainerRecord[] = useMemo(
    () =>
      openTabs
        .map((id) => containers.find((c) => c.id === id))
        .filter((c): c is ContainerRecord => Boolean(c)),
    [openTabs, containers],
  );
  const active: ContainerRecord | undefined = containers.find((c) => c.id === activeTabId);
  const splitContainer: ContainerRecord | null =
    splitId !== null && splitId !== activeTabId
      ? (containers.find((c) => c.id === splitId) ?? null)
      : null;

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
        setActiveTabId((current) => {
          if (current !== id) return current;
          const wasIdx = prev.indexOf(id);
          if (wasIdx === -1) return current;
          if (next.length === 0) return null;
          return next[Math.min(wasIdx, next.length - 1)];
        });
        return next;
      });
      // Closing the split pane's container also collapses the split.
      setSplitId((current) => (current === id ? null : current));
    },
    [setOpenTabs, setActiveTabId, setSplitId],
  );

  const newClaudeSession = useCallback(
    (id: number) => {
      localStorage.setItem(`${LS_LAST_KIND_PREFIX}${id}`, "claude");
      setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setActiveTabId(id);
    },
    [setOpenTabs, setActiveTabId],
  );

  const toggleSplit = useCallback(() => {
    // Split = "open the next container in the open-tab list next to the
    // active one". If only one container is open there is nothing to
    // split with — the button is disabled in that case.
    if (splitId !== null) {
      setSplitId(null);
      return;
    }
    const partner = openTabs.find((id) => id !== activeTabId);
    if (partner !== undefined) setSplitId(partner);
  }, [splitId, openTabs, activeTabId, setSplitId]);

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

  // M13. The "unreachable" half of this check only fires for records
  // where the hub actually expected a hive-agent. Containers registered
  // via the Discover tab without provisioning (agent_expected=false)
  // run fine over docker_exec, so heartbeat silence is not a fault and
  // we must not surface it as one.
  const selectedUnhealthy =
    active !== undefined &&
    (active.container_status !== "running" ||
      (active.agent_status === "unreachable" && active.agent_expected));
  const firstHealthy = useMemo(
    () =>
      openContainers.find(
        (c) => c.container_status === "running" && c.agent_status !== "unreachable",
      ),
    [openContainers],
  );

  const sidebarTitle =
    activity === "containers"
      ? "Containers"
      : activity === "gitops"
        ? "Git Ops"
        : activity === "scm"
          ? "Source Control"
          : activity === "problems"
            ? "Problems"
            : activity === "settings"
              ? "Settings"
              : activity === "keybindings"
                ? "Keybindings"
                : "Search";

  // M14: keep imperative Panel handles so keybindings can drive
  // collapse/expand without losing the user's dragged widths. The
  // sidebarOpen/secondaryOpen booleans remain the *intent* the user
  // expressed; the Panel's pixel widths are persisted through a
  // ``useLocalStorage`` layout record keyed by panel id.
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const secondaryPanelRef = useRef<PanelImperativeHandle | null>(null);
  const [rootLayout, setRootLayout] = useLocalStorage<Layout>(LS_ROOT_LAYOUT, DEFAULT_ROOT_LAYOUT, {
    validate: isLayout,
  });
  useEffect(() => {
    const handle = sidebarPanelRef.current;
    if (!handle) return;
    if (sidebarOpen && handle.isCollapsed()) handle.expand();
    if (!sidebarOpen && !handle.isCollapsed()) handle.collapse();
  }, [sidebarOpen]);
  useEffect(() => {
    const handle = secondaryPanelRef.current;
    if (!handle) return;
    if (secondaryOpen && handle.isCollapsed()) handle.expand();
    if (!secondaryOpen && !handle.isCollapsed()) handle.collapse();
  }, [secondaryOpen]);

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
            problemCount={problemCount}
            onOpenCommandPalette={() => setPaletteOpen(true)}
          />

          <Group
            orientation="horizontal"
            id="hive-root-layout"
            defaultLayout={rootLayout}
            onLayoutChanged={setRootLayout}
            style={{ flex: 1, minWidth: 0, minHeight: 0 }}
          >
            <Panel
              id="hive-sidebar"
              panelRef={sidebarPanelRef}
              defaultSize={20}
              minSize={12}
              collapsible
              collapsedSize={0}
              onResize={(size) => {
                // react-resizable-panels v4 doesn't surface onCollapse/
                // onExpand — detect them by the panel's size going to/from
                // zero. The guard prevents the effect-driven collapse loop
                // from fighting itself when sidebarOpen was already false.
                const collapsedNow = size.asPercentage === 0;
                if (collapsedNow && sidebarOpen) setSidebarOpen(false);
                else if (!collapsedNow && !sidebarOpen) setSidebarOpen(true);
              }}
            >
              <aside
                aria-label="Primary sidebar"
                className="flex h-full flex-col border-r border-[#2b2b2b] bg-[#1e1e1e]"
              >
                <header className="flex items-center justify-between border-b border-[#2b2b2b] px-3 py-1.5">
                  <h2 className="text-[10px] font-semibold tracking-wider text-[#858585] uppercase">
                    {sidebarTitle}
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
                  {activity === "scm" && <SourceControlView />}
                  {activity === "problems" && <ProblemsPanel />}
                  {activity === "settings" && <SettingsView />}
                  {activity === "keybindings" && <KeybindingsEditor />}
                </div>
              </aside>
            </Panel>

            <Separator
              className="w-0.5 cursor-col-resize bg-[#2b2b2b] transition-colors hover:bg-[#0078d4]"
              aria-label="Resize primary sidebar"
            />

            <Panel id="hive-editor" minSize={30} defaultSize={60}>
              {/* Editor area: tabs + active pane (or split) */}
              <main className="flex h-full min-w-0 flex-col bg-[#1e1e1e]">
                <div className="flex items-stretch">
                  <div className="min-w-0 flex-1">
                    <ContainerTabs
                      openContainers={openContainers}
                      activeId={activeTabId}
                      onFocus={setActiveTabId}
                      onClose={closeTab}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={toggleSplit}
                    disabled={openTabs.length < 2 && splitId === null}
                    className={`flex items-center gap-1 border-b border-[#2b2b2b] px-3 text-[11px] transition-colors ${
                      splitId !== null
                        ? "bg-[#2a2d2e] text-[#e7e7e7]"
                        : "text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
                    } disabled:opacity-40`}
                    title={splitId !== null ? "Close split" : "Split editor"}
                    aria-label={splitId !== null ? "Close split" : "Split editor"}
                  >
                    <Columns size={12} />
                  </button>
                </div>
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
                    {splitContainer !== null ? (
                      <SplitEditor
                        primary={active}
                        secondary={splitContainer}
                        onCloseSecondary={() => setSplitId(null)}
                      />
                    ) : (
                      <div className="flex min-h-0 min-w-0 flex-1 p-2">
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
                    )}
                  </div>
                ) : (
                  <EmptyEditor
                    onOpenProvisioner={() => setShowProvisioner(true)}
                    hasRegistered={containers.length > 0}
                  />
                )}
              </main>
            </Panel>

            <Separator
              className="w-0.5 cursor-col-resize bg-[#2b2b2b] transition-colors hover:bg-[#0078d4]"
              aria-label="Resize secondary panel"
            />

            <Panel
              id="hive-secondary"
              panelRef={secondaryPanelRef}
              defaultSize={0}
              minSize={14}
              collapsible
              collapsedSize={0}
              onResize={(size) => {
                const collapsedNow = size.asPercentage === 0;
                if (collapsedNow && secondaryOpen) setSecondaryOpen(false);
                else if (!collapsedNow && !secondaryOpen) setSecondaryOpen(true);
              }}
            >
              <aside
                aria-label="Secondary panel"
                className="h-full overflow-y-auto border-l border-[#2b2b2b] bg-[#1e1e1e] p-3"
              >
                <h2 className="mb-2 text-[10px] font-semibold tracking-wider text-[#858585] uppercase">
                  Resources
                </h2>
                {active ? (
                  <ResourceMonitor containerId={active.id} />
                ) : (
                  <p className="text-[11px] text-[#606060]">
                    Open a container to see its CPU, memory, and GPU bars here.
                  </p>
                )}
              </aside>
            </Panel>
          </Group>
        </div>

        <StatusBar
          activeContainerId={active?.id ?? null}
          activeContainerName={active?.project_name ?? null}
        />

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
