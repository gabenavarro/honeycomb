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
import { Columns } from "lucide-react";
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
import { Breadcrumbs } from "./components/Breadcrumbs";
import { CommandPalette } from "./components/CommandPalette";
import { ContainerFilesView } from "./components/ContainerFilesView";
import { ContainerList } from "./components/ContainerList";
import { ContainerTabs } from "./components/ContainerTabs";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FileViewer } from "./components/FileViewer";
import { GitOpsPanel } from "./components/GitOpsPanel";
import { HelpOverlay } from "./components/HelpOverlay";
import { KeybindingsEditor } from "./components/KeybindingsEditor";
import { LocalStorageQuotaWatcher } from "./components/LocalStorageQuotaWatcher";
import { ProblemsPanel } from "./components/ProblemsPanel";
import { Provisioner } from "./components/Provisioner";
import { SessionSplitArea } from "./components/SessionSplitArea";
import { SessionSubTabs, type SessionInfo } from "./components/SessionSubTabs";
import { SettingsView } from "./components/SettingsView";
import { SourceControlView } from "./components/SourceControlView";
import { SplitEditor } from "./components/SplitEditor";
import { StaleHubWatcher } from "./components/StaleHubWatcher";
import { StatusBar } from "./components/StatusBar";
import { WebSocketListenerErrorWatcher } from "./components/WebSocketListenerErrorWatcher";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { purgeContainerSessions } from "./hooks/useSessionStore";
import { useSessions } from "./hooks/useSessions";
import { useToasts } from "./hooks/useToasts";
import { backoffRefetch } from "./hooks/useSmartPoll";
import { dispatchPretype } from "./lib/pretypeBus";
import { runSessionMigration } from "./lib/migrateSessions";
import {
  createNamedSession,
  getContainerWorkdir,
  getSettings,
  listContainerSessions,
  listContainers,
  listPRs,
  listProblems,
} from "./lib/api";
import type { ContainerRecord } from "./lib/types";
import { HealthTimeline } from "./components/HealthTimeline";

// Storage keys for layout state. Remembering these across reloads is
// expected behavior for an IDE-style app.
const LS_OPEN_TABS = "hive:layout:openTabs";
const LS_ACTIVE_TAB = "hive:layout:activeTab";
const LS_ACTIVITY = "hive:layout:activity";
const LS_SIDEBAR_OPEN = "hive:layout:sidebar";
const LS_SPLIT_ID = "hive:layout:splitId";
const LS_ROOT_LAYOUT = "hive:layout:rootPanels";
const LS_ROOT_LAYOUT_BY_CONTAINER = "hive:layout:rootPanelsByContainer"; // M21 L
// M26 — active-session id per container (client-only; the authoritative
// session list + names come from /api/containers/{id}/named-sessions).
const LS_ACTIVE_SESSION_ID = "hive:layout:activeSessionByContainer";
const LS_FS_PATHS = "hive:layout:fsPaths"; // M17 — per-container browsed path
const LS_SESSION_SPLIT = "hive:layout:sessionSplit"; // M22.4 — per-container secondary session
const LS_LAST_KIND_PREFIX = "hive:terminal-last-kind:";

function isActiveSessionIdMap(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((s) => typeof s === "string");
}
function isFsPathMap(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((s) => typeof s === "string");
}
function isSessionSplitMap(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((s) => typeof s === "string");
}

const ACTIVITY_VALUES: Activity[] = [
  "containers",
  "gitops",
  "problems",
  "scm",
  "search",
  "settings",
  "keybindings",
  "files",
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
function isLayoutByContainer(v: unknown): v is Record<string, Layout> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((layout) => isLayout(layout));
}

const DEFAULT_ROOT_LAYOUT: Layout = {
  "hive-sidebar": 20,
  "hive-editor": 80,
};

export default function App() {
  const queryClient = useQueryClient();

  // M26 — one-shot migration from legacy localStorage to the hub.
  // Idempotent via the guard key; this effect fires at most once
  // per mount (React StrictMode double-runs effects; the guard
  // makes the second call a no-op).
  useEffect(() => {
    void runSessionMigration().then((result) => {
      if (result.migrated > 0) {
        console.info("[m26] migrated", result.migrated, "sessions");
      }
    });
  }, []);

  const [activity, setActivity] = useLocalStorage<Activity>(LS_ACTIVITY, "containers", {
    validate: isActivity,
  });
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>(LS_SIDEBAR_OPEN, true, {
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
  const [helpOpen, setHelpOpen] = useState(false);

  const [activeSessionByContainer, setActiveSessionByContainer] = useLocalStorage<
    Record<string, string>
  >(LS_ACTIVE_SESSION_ID, {}, { validate: isActiveSessionIdMap });
  // M17 — the currently browsed container-filesystem path per container.
  // Empty until the user (or Breadcrumbs' mount effect) picks one up
  // from the container's WORKDIR.
  const [fsPathByContainer, setFsPathByContainer] = useLocalStorage<Record<string, string>>(
    LS_FS_PATHS,
    {},
    { validate: isFsPathMap },
  );
  // M22.4 — drag a session tab onto the editor to pin a second session
  // next to the primary one. One split per container; clearing is
  // explicit (close button on the secondary pane).
  const [sessionSplitByContainer, setSessionSplitByContainer] = useLocalStorage<
    Record<string, string>
  >(LS_SESSION_SPLIT, {}, { validate: isSessionSplitMap });

  const { data: containers = [], isSuccess: containersLoaded } = useQuery({
    queryKey: ["containers"],
    queryFn: listContainers,
    refetchInterval: backoffRefetch(),
  });
  // M25 — read settings so the health timeline can be toggled off
  // globally. 30s staleTime since settings rarely change.
  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const timelineVisible = Boolean(
    (settingsData?.values as { timeline_visible?: boolean } | undefined)?.timeline_visible ?? true,
  );
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

  // M23 — WORKDIR for the active container, fed to the palette for
  // suggestion parsing + the walk endpoint's default root.
  const { data: activeWorkdirData } = useQuery({
    queryKey: ["workdir", active?.id ?? 0],
    queryFn: () => getContainerWorkdir(active!.id),
    enabled: active !== undefined,
    staleTime: 60_000,
  });
  const activeWorkdir = activeWorkdirData?.path ?? "";

  // M26 — sessions come from the hub. The active-session ID per
  // container stays client-side (which tab is focused — different
  // from the session list itself).
  const {
    sessions: namedSessions,
    create: createSessionApi,
    rename: renameSessionApi,
    close: closeSessionApi,
  } = useSessions(active?.id ?? null);

  // Map NamedSession → SessionInfo ({id, name}) for SessionSubTabs.
  const activeSessions: SessionInfo[] = useMemo(
    () =>
      active === undefined
        ? []
        : namedSessions.map((s) => ({ id: s.session_id, name: s.name })),
    [active, namedSessions],
  );

  const activeSessionId: string = useMemo(() => {
    if (active === undefined) return "";
    const stored = activeSessionByContainer[String(active.id)];
    if (stored && activeSessions.some((s) => s.id === stored)) return stored;
    return activeSessions[0]?.id ?? "";
  }, [active, activeSessionByContainer, activeSessions]);

  // M26 — first-load-empty guard: auto-create a default shell session
  // so the tab strip never renders blank after migration.
  const firstEmptyGuardRef = useRef(false);
  useEffect(() => {
    if (active === undefined) return;
    if (namedSessions.length > 0) return;
    if (firstEmptyGuardRef.current) return;
    firstEmptyGuardRef.current = true;
    void createSessionApi({ name: "Main", kind: "shell" });
  }, [active, namedSessions, createSessionApi]);
  useEffect(() => {
    // Reset the guard when the active container changes.
    firstEmptyGuardRef.current = false;
  }, [active?.id]);

  const focusSession = useCallback(
    (sessionId: string) => {
      if (active === undefined) return;
      setActiveSessionByContainer((prev) => ({
        ...prev,
        [String(active.id)]: sessionId,
      }));
    },
    [active, setActiveSessionByContainer],
  );

  const activeFsPath: string = useMemo(() => {
    if (active === undefined) return "";
    return fsPathByContainer[String(active.id)] ?? "";
  }, [active, fsPathByContainer]);

  // M22.4 — validated split session for the active container. Drops
  // are silently ignored when the target session no longer exists
  // (e.g. user closed it before releasing the drag).
  const activeSplitSessionId: string | null = useMemo(() => {
    if (active === undefined) return null;
    const id = sessionSplitByContainer[String(active.id)];
    if (!id) return null;
    if (!activeSessions.some((s) => s.id === id)) return null;
    if (id === activeSessionId) return null;
    return id;
  }, [active, sessionSplitByContainer, activeSessions, activeSessionId]);

  const setActiveSplitSession = useCallback(
    (sessionId: string) => {
      if (active === undefined) return;
      setSessionSplitByContainer((prev) => ({ ...prev, [String(active.id)]: sessionId }));
    },
    [active, setSessionSplitByContainer],
  );

  const clearActiveSplitSession = useCallback(() => {
    if (active === undefined) return;
    setSessionSplitByContainer((prev) => {
      const key = String(active.id);
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, [active, setSessionSplitByContainer]);

  const setActiveFsPath = useCallback(
    (path: string) => {
      if (active === undefined) return;
      setFsPathByContainer((prev) => ({ ...prev, [String(active.id)]: path }));
    },
    [active, setFsPathByContainer],
  );

  const newSession = useCallback(async () => {
    if (active === undefined) return;
    const rawName = window.prompt(
      `Name for the new session on ${active.project_name}:`,
      `session ${namedSessions.length + 1}`,
    );
    if (rawName === null) return;
    const name = rawName.trim() || `session ${namedSessions.length + 1}`;
    const created = await createSessionApi({ name, kind: "shell" });
    focusSession(created.session_id);
  }, [active, namedSessions.length, createSessionApi, focusSession]);

  const renameSession = useCallback(
    async (sessionId: string, nextName: string) => {
      await renameSessionApi(sessionId, nextName);
    },
    [renameSessionApi],
  );

  const closeSession = useCallback(
    async (sessionId: string) => {
      if (namedSessions.length <= 1) return; // keep at least one
      await closeSessionApi(sessionId);
      if (active === undefined) return;
      // If the closed session was active, pivot to the first remaining.
      if (activeSessionByContainer[String(active.id)] === sessionId) {
        const remaining = namedSessions.filter((s) => s.session_id !== sessionId);
        setActiveSessionByContainer((prev) => ({
          ...prev,
          [String(active.id)]: remaining[0]?.session_id ?? "",
        }));
      }
    },
    [active, namedSessions, activeSessionByContainer, closeSessionApi, setActiveSessionByContainer],
  );

  // M26: reorder is a no-op for now. Future M28 adds drag-to-reorder.
  const reorderSession = useCallback(() => {
    /* M28 */
  }, []);
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
    async (id: number) => {
      localStorage.setItem(`${LS_LAST_KIND_PREFIX}${id}`, "claude");
      setOpenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setActiveTabId(id);
      // Create a Claude session for the newly focused container.
      const target = containers.find((c) => c.id === id);
      if (target === undefined) return;
      const created = await createNamedSession(id, { name: "Claude", kind: "claude" });
      setActiveSessionByContainer((prev) => ({
        ...prev,
        [String(id)]: created.session_id,
      }));
    },
    [containers, setOpenTabs, setActiveTabId, setActiveSessionByContainer],
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
    // Secondary panel was removed in M20 — Ctrl+` is a no-op now but
    // the handler stays in the shortcut registry so the hotkey is
    // reserved for a future repurposing.
    onToggleSecondary: () => undefined,
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
    onShowHelp: () => setHelpOpen(true),
  });

  // M13 + M20. The "unreachable" half of this check fires only when
  // (a) the hub was expecting a hive-agent for this record AND
  // (b) there is no live PTY session attached (i.e. the user isn't
  //     already successfully talking to the container over docker_exec).
  //
  // Legacy rows registered before M13 carry ``agent_expected=true``
  // even though they have no agent installed. Gating on live-PTY
  // presence hides the false positive without requiring a retro
  // database backfill.
  const { data: liveSessions } = useQuery({
    queryKey: ["sessions", active?.id ?? 0],
    queryFn: () => listContainerSessions(active!.id),
    enabled: active !== undefined,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
  const hasLiveAttachedPty =
    liveSessions?.sessions.some((s) => s.attached || s.detached_for_seconds !== null) ?? false;
  void hasLiveAttachedPty; // retained for reference; banner removed in M22.3

  // M22.3 — emit one-shot toasts when a container's agent_status
  // transitions into / out of ``unreachable``. The persistent dot on
  // the container tab (M20) remains the steady-state indicator; the
  // toast is just the event, which is also recorded in the bell
  // history so the user can review later.
  const { toast } = useToasts();
  const prevAgentStatusRef = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    const prev = prevAgentStatusRef.current;
    for (const c of containers) {
      const wasStatus = prev.get(c.id);
      if (wasStatus === undefined) {
        prev.set(c.id, c.agent_status);
        continue;
      }
      if (wasStatus === c.agent_status) continue;
      prev.set(c.id, c.agent_status);
      // Only notify when the record actually expected an agent —
      // Discover-registered containers with agent_expected=false live
      // on docker_exec and don't deserve a "recovery" message either.
      if (!c.agent_expected) continue;
      if (c.agent_status === "unreachable") {
        toast(
          "warning",
          `${c.project_name} is unreachable`,
          "The hive-agent hasn't heartbeated. Container still usable via docker_exec.",
        );
      } else if (wasStatus === "unreachable") {
        toast("info", `${c.project_name} is reachable again`, "Agent heartbeat resumed.");
      }
    }
  }, [containers, toast]);

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
                : activity === "files"
                  ? "Files"
                  : "Search";

  // M18 — the file currently opened in the inline viewer. Keyed on the
  // active container so switching containers doesn't leak a file from
  // another workspace into view. Closing the viewer sets it back to
  // null.
  const [openedFile, setOpenedFile] = useState<string | null>(null);
  useEffect(() => {
    // Reset viewer when the active container changes.
    setOpenedFile(null);
  }, [active?.id]);

  // M14: keep imperative Panel handles so keybindings can drive
  // collapse/expand without losing the user's dragged widths. The
  // sidebarOpen/secondaryOpen booleans remain the *intent* the user
  // expressed; the Panel's pixel widths are persisted through a
  // ``useLocalStorage`` layout record keyed by panel id.
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);
  const [rootLayout, setRootLayout] = useLocalStorage<Layout>(LS_ROOT_LAYOUT, DEFAULT_ROOT_LAYOUT, {
    validate: isLayout,
  });
  // M21 L — per-container layouts. When the user switches tabs we
  // re-key the Group with this container's saved sizes; on drag we
  // write back to both the per-container map AND the global default
  // so a brand-new container starts with the user's latest widths.
  const [layoutByContainer, setLayoutByContainer] = useLocalStorage<Record<string, Layout>>(
    LS_ROOT_LAYOUT_BY_CONTAINER,
    {},
    { validate: isLayoutByContainer },
  );
  const activeLayoutKey = activeTabId === null ? null : String(activeTabId);
  const activeRootLayout: Layout =
    (activeLayoutKey !== null && layoutByContainer[activeLayoutKey]) || rootLayout;
  const setActiveRootLayout = useCallback(
    (next: Layout) => {
      setRootLayout(next);
      if (activeLayoutKey !== null) {
        setLayoutByContainer((prev) => ({ ...prev, [activeLayoutKey]: next }));
      }
    },
    [setRootLayout, setLayoutByContainer, activeLayoutKey],
  );
  useEffect(() => {
    const handle = sidebarPanelRef.current;
    if (!handle) return;
    if (sidebarOpen && handle.isCollapsed()) handle.expand();
    if (!sidebarOpen && !handle.isCollapsed()) handle.collapse();
  }, [sidebarOpen]);

  return (
    <AuthGate>
      <LocalStorageQuotaWatcher />
      <WebSocketListenerErrorWatcher />
      <StaleHubWatcher />
      <div className="flex h-screen flex-col bg-[#1e1e1e] text-[#cccccc]">
        <div className="flex min-h-0 flex-1">
          <ActivityBar
            active={activity}
            onChange={(a) => {
              // M22.2 — only auto-open the sidebar when switching to a
              // different activity. Clicking the already-active icon
              // leaves ``sidebarOpen`` alone so the accompanying
              // double-click gesture can toggle cleanly without the
              // intermediate single-clicks fighting it.
              if (a !== activity) {
                setActivity(a);
                setSidebarOpen(true);
              }
            }}
            containerCount={containers.length}
            prCount={prs.length}
            problemCount={problemCount}
            onOpenCommandPalette={() => setPaletteOpen(true)}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
          />

          <Group
            // Remount the group on container switch so the stored
            // per-container layout is applied on mount rather than
            // fighting a live drag. ``activeLayoutKey`` is the stable
            // identity — if no container is focused we fall back to a
            // static key so the group still mounts once.
            key={`root-${activeLayoutKey ?? "none"}`}
            orientation="horizontal"
            id="hive-root-layout"
            defaultLayout={activeRootLayout}
            onLayoutChanged={setActiveRootLayout}
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
                // The Panel collapses to 0% width but the child aside has
                // no ``w-full`` class, so its intrinsic width stays > 0
                // and assistive tech would still see its content. ``hidden``
                // flips ``display:none`` when collapsed — the Panel's
                // onResize keeps ``sidebarOpen`` in sync when the user
                // drags the separator, so drag-to-reopen keeps working.
                hidden={!sidebarOpen}
                className="flex h-full flex-col border-r border-[#2b2b2b] bg-[#1e1e1e]"
              >
                <header className="flex items-center justify-between gap-2 border-b border-[#2b2b2b] px-3 py-1.5">
                  <h2 className="flex min-w-0 items-baseline gap-2 text-[10px] font-semibold tracking-wider text-[#858585] uppercase">
                    <span className="shrink-0">{sidebarTitle}</span>
                    {activity === "files" && activeFsPath && (
                      <span
                        className="min-w-0 truncate font-mono text-[10px] tracking-normal text-[#c0c0c0] normal-case"
                        title={activeFsPath}
                      >
                        {activeFsPath}
                      </span>
                    )}
                  </h2>
                  {activity === "containers" && (
                    // M21 A — more prominent primary-colour CTA so the
                    // main "register a new container" action is obvious
                    // on a cold load.
                    <button
                      type="button"
                      onClick={() => setShowProvisioner(true)}
                      className="flex items-center gap-1 rounded bg-[#0078d4] px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-[#1188e0] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                      title="Register or discover a new devcontainer"
                    >
                      <span aria-hidden="true">+</span>
                      <span>New</span>
                    </button>
                  )}
                </header>
                <div className="flex-1 overflow-y-auto">
                  {activity === "containers" && (
                    <ContainerList selectedId={activeTabId} onSelect={openContainer} />
                  )}
                  {activity === "gitops" && <GitOpsPanel />}
                  {activity === "scm" && <SourceControlView />}
                  {activity === "problems" && (
                    <ProblemsPanel
                      onOpenContainer={(id) => {
                        openContainer(id);
                        setActivity("containers");
                      }}
                    />
                  )}
                  {activity === "settings" && <SettingsView />}
                  {activity === "keybindings" && <KeybindingsEditor />}
                  {activity === "files" && (
                    <ContainerFilesView
                      containerId={active?.id ?? null}
                      path={activeFsPath}
                      onNavigate={setActiveFsPath}
                      onOpenFile={setOpenedFile}
                    />
                  )}
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
                    {/* M22.3 removed the always-visible yellow banner —
                        the ``AgentStatusDot`` on the container tab is
                        the steady-state indicator, and a transition
                        toast is emitted above when agent_status flips. */}
                    {splitContainer !== null ? (
                      <SplitEditor
                        primary={active}
                        secondary={splitContainer}
                        onCloseSecondary={() => setSplitId(null)}
                      />
                    ) : (
                      <>
                        {/* M17 — container path breadcrumbs. */}
                        <Breadcrumbs
                          containerId={active.id}
                          path={activeFsPath}
                          onPathChange={setActiveFsPath}
                        />
                        {/* M25 — three-sparkline health strip. Gated by
                            the ``timeline_visible`` hub setting so users
                            can hide it globally across every device that
                            syncs via this hub. */}
                        {timelineVisible && <HealthTimeline containerId={active.id} />}
                        {/* M16 — nested session tabs under the container. */}
                        <SessionSubTabs
                          sessions={activeSessions}
                          activeId={activeSessionId}
                          onFocus={focusSession}
                          onClose={closeSession}
                          onNew={newSession}
                          onRename={renameSession}
                          onReorder={reorderSession}
                        />
                        {/* M18 — FileViewer takes over the editor pane
                            when the user opens a file from the Files
                            sidebar. Closing falls back to the terminal. */}
                        {openedFile !== null ? (
                          <div className="flex min-h-0 min-w-0 flex-1">
                            <ErrorBoundary
                              key={`eb-file-${active.id}-${openedFile}`}
                              label={`the ${openedFile} viewer`}
                            >
                              <FileViewer
                                key={`${active.id}-${openedFile}`}
                                containerId={active.id}
                                path={openedFile}
                                onClose={() => setOpenedFile(null)}
                              />
                            </ErrorBoundary>
                          </div>
                        ) : (
                          <SessionSplitArea
                            containerId={active.id}
                            containerName={active.project_name}
                            hasClaudeCli={active.has_claude_cli}
                            sessions={activeSessions}
                            primarySessionId={activeSessionId}
                            splitSessionId={activeSplitSessionId}
                            onSetSplit={setActiveSplitSession}
                            onClearSplit={clearActiveSplitSession}
                          />
                        )}
                      </>
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
          </Group>
        </div>

        <StatusBar
          activeContainerId={active?.id ?? null}
          activeContainerName={active?.project_name ?? null}
        />

        <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />

        {showProvisioner && <Provisioner onClose={() => setShowProvisioner(false)} />}

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          containers={containers}
          activeContainerId={active?.id ?? null}
          activeWorkdir={activeWorkdir}
          onFocusContainer={openContainer}
          onCloseContainer={closeTab}
          onNewClaudeSession={newClaudeSession}
          onActivity={(a) => {
            setActivity(a);
            setSidebarOpen(true);
          }}
          onOpenProvisioner={() => setShowProvisioner(true)}
          onOpenFile={(path) => {
            if (active !== undefined) {
              setOpenedFile(path);
            }
          }}
          onRunSuggestion={(command) => {
            if (active === undefined) return;
            // Ensure the container tab is open and focused. subscribePretype
            // filters on (recordId, sessionKey), so the send is a no-op if
            // the PTY is still mounting. Users can re-run from the palette.
            openContainer(active.id);
            dispatchPretype({
              recordId: active.id,
              sessionKey: activeSessionId,
              text: command,
            });
          }}
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
