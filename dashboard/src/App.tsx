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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { type Layout } from "react-resizable-panels";

import { ActivityBar, type Activity } from "./components/ActivityBar";
import { AuthGate } from "./components/AuthGate";
import { CommandPalette } from "./components/CommandPalette";
import { LocalStorageQuotaWatcher } from "./components/LocalStorageQuotaWatcher";
import { PhoneTabBar, type PhoneTab } from "./components/PhoneTabBar";
import { Provisioner } from "./components/Provisioner";
import { HelpOverlay } from "./components/HelpOverlay";
import { type SessionInfo } from "./components/SessionSubTabs";
import { StaleHubWatcher } from "./components/StaleHubWatcher";
import { StatusBar } from "./components/StatusBar";
import { WebSocketListenerErrorWatcher } from "./components/WebSocketListenerErrorWatcher";
import { ChatsRoute } from "./components/routes/ChatsRoute";
import { LibraryRoute } from "./components/routes/LibraryRoute";
import { FilesRoute } from "./components/routes/FilesRoute";
import { SettingsRoute } from "./components/routes/SettingsRoute";
import { useIsPhone } from "./hooks/useMediaQuery";
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
  listContainers,
  listPRs,
  listProblems,
} from "./lib/api";
import { pathnameForRoute, routeForActivity, routeForPathname, type RouteId } from "./lib/routes";
import type { ContainerRecord, DiffEvent } from "./lib/types";

// Storage keys for layout state. Remembering these across reloads is
// expected behavior for an IDE-style app.
const LS_OPEN_TABS = "hive:layout:openTabs";
const LS_ACTIVE_TAB = "hive:layout:activeTab";
const LS_ACTIVITY = "hive:layout:activity";
const LS_SIDEBAR_OPEN = "hive:layout:sidebar";
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
  "diff-events",
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

// M36 — PhoneTab ↔ Activity mapping for the phone bottom-nav. The
// phone tab union (chats / library / files / git / more) is a flatter
// view of the M32 activity space; "git" maps to the SCM sub-activity
// (which lives inside the Files route in the URL space), and "more"
// is a placeholder for Settings until a dedicated More page lands.
function activityToPhoneTab(a: Activity): PhoneTab {
  switch (a) {
    case "containers":
    case "gitops":
    case "search":
      return "chats";
    case "diff-events":
      return "library";
    case "files":
    case "problems":
    case "keybindings":
      return "files";
    case "scm":
      return "git";
    case "settings":
      return "more";
  }
}

function phoneTabToActivity(t: PhoneTab): Activity {
  switch (t) {
    case "chats":
      return "containers";
    case "library":
      return "diff-events";
    case "files":
      return "files";
    case "git":
      return "scm";
    case "more":
      return "settings";
  }
}

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
  // M32 — `sidebarOpen` is retained as a persisted intent; the new
  // route-owned sidebars don't react to it yet but M33+ collapse
  // gestures will. Keep the setter wired so the value still flips.
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>(LS_SIDEBAR_OPEN, true, {
    validate: isBoolean,
  });
  void sidebarOpen;
  const [openTabs, setOpenTabs] = useLocalStorage<number[]>(LS_OPEN_TABS, [], {
    validate: isNumberArray,
  });
  const [activeTabId, setActiveTabId] = useLocalStorage<number | null>(LS_ACTIVE_TAB, null, {
    validate: isNullableNumber,
  });
  const [showProvisioner, setShowProvisioner] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // M32 — URL ↔ activity sync. The URL is the source of truth for
  // which top-level route is showing; ``activity`` remains the inner
  // state that drives sidebar sub-tabs (Files / SCM / Problems /
  // Keybindings inside the Files route, etc.).
  const location = useLocation();
  const navigate = useNavigate();
  const currentRoute: RouteId = routeForPathname(location.pathname);

  useEffect(() => {
    const r = routeForActivity(activity);
    if (r !== currentRoute) {
      const fallbackActivity: Activity =
        currentRoute === "chats"
          ? "containers"
          : currentRoute === "library"
            ? "diff-events"
            : currentRoute === "files"
              ? "files"
              : "settings";
      setActivity(fallbackActivity);
    }
  }, [currentRoute, activity, setActivity]);

  const goToRoute = useCallback(
    (route: RouteId) => {
      navigate(pathnameForRoute(route));
    },
    [navigate],
  );

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
    }
  }, [containersLoaded, containers, openTabs, activeTabId, setOpenTabs, setActiveTabId]);

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
    isLoading: sessionsLoading,
    create: createSessionApi,
    rename: renameSessionApi,
    close: closeSessionApi,
    reorder: reorderSessionApi,
  } = useSessions(active?.id ?? null);

  // Map NamedSession → SessionInfo ({id, name}) for SessionSubTabs.
  const activeSessions: SessionInfo[] = useMemo(
    () =>
      active === undefined ? [] : namedSessions.map((s) => ({ id: s.session_id, name: s.name })),
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
  // Gate on !sessionsLoading so we don't fire before the hub has had a
  // chance to respond — avoids cancelling the in-flight GET and losing
  // any sessions the hub already knows about.
  const firstEmptyGuardRef = useRef(false);
  useEffect(() => {
    if (active === undefined) return;
    if (sessionsLoading) return;
    if (namedSessions.length > 0) return;
    if (firstEmptyGuardRef.current) return;
    firstEmptyGuardRef.current = true;
    void createSessionApi({ name: "Main", kind: "shell" });
  }, [active, namedSessions, sessionsLoading, createSessionApi]);
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

  // M28 — translate M21 D's (fromId, toId) drag signal into a
  // position for the server. The target's current position is where
  // the moved row lands; patch_session's renumber absorbs the shift.
  // Legacy rows at position 0 fall back to their array index + 1.
  const reorderSession = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const fromIdx = namedSessions.findIndex((s) => s.session_id === fromId);
      const toIdx = namedSessions.findIndex((s) => s.session_id === toId);
      if (fromIdx < 0 || toIdx < 0) return;
      const target = namedSessions[toIdx];
      const newPosition = target.position > 0 ? target.position : toIdx + 1;
      void reorderSessionApi(fromId, newPosition);
    },
    [namedSessions, reorderSessionApi],
  );
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
    },
    [setOpenTabs, setActiveTabId],
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

  useKeyboardShortcuts({
    onCommandPalette: () => setPaletteOpen((v) => !v),
    onToggleSidebar: () => setSidebarOpen((v) => !v),
    onToggleSecondary: () => undefined,
    onCloseActiveTab: () => {
      if (activeTabId !== null) closeTab(activeTabId);
    },
    onFocusTabByIndex: (idx) => {
      const tab = openTabs[idx];
      if (tab !== undefined) setActiveTabId(tab);
    },
    onActivateRoute: (route) => {
      goToRoute(route);
    },
    onShowHelp: () => setHelpOpen(true),
  });

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

  // M18 — the file currently opened in the inline viewer. Keyed on the
  // active container so switching containers doesn't leak a file from
  // another workspace into view. Closing the viewer sets it back to
  // null.
  const [openedFile, setOpenedFile] = useState<string | null>(null);
  useEffect(() => {
    // Reset viewer when the active container changes.
    setOpenedFile(null);
  }, [active?.id]);

  // M27 — the diff event currently open in the inline DiffViewerTab.
  // Mirrors the openedFile pattern: keyed on active container, resets
  // on container switch, and takes priority over the session terminal
  // just like FileViewer does.
  const [openedDiffEvent, setOpenedDiffEvent] = useState<DiffEvent | null>(null);
  useEffect(() => {
    setOpenedDiffEvent(null);
  }, [active?.id]);

  // M14 / M21 L — root-pane layout state retained for M33+. The
  // resizable shell is gone in M32 (each route owns its own sidebar
  // width), but these persisted records are kept so future split-pane
  // work can pick them back up without a storage migration.
  const [rootLayout, setRootLayout] = useLocalStorage<Layout>(LS_ROOT_LAYOUT, DEFAULT_ROOT_LAYOUT, {
    validate: isLayout,
  });
  const [layoutByContainer, setLayoutByContainer] = useLocalStorage<Record<string, Layout>>(
    LS_ROOT_LAYOUT_BY_CONTAINER,
    {},
    { validate: isLayoutByContainer },
  );
  void rootLayout;
  void setRootLayout;
  void layoutByContainer;
  void setLayoutByContainer;

  // M36 — phone bottom-nav. ActivityBar already auto-hides at phone via
  // its `hidden tablet:flex` class (T5), so the PhoneTabBar simply
  // appears at the bottom of the layout when isPhone is true. Hidden
  // when the user is in a chat-detail view (active container with a
  // selected session on /chats) so the composer gets full vertical
  // room per the M36 spec.
  const isPhone = useIsPhone();
  const phoneInChatDetail =
    isPhone && currentRoute === "chats" && active !== undefined && activeSessionId !== "";

  return (
    <AuthGate>
      <LocalStorageQuotaWatcher />
      <WebSocketListenerErrorWatcher />
      <StaleHubWatcher />
      <div className="bg-page text-primary flex h-screen flex-col">
        <div className="flex min-h-0 flex-1">
          <ActivityBar
            active={activity}
            onChange={(a) => {
              setActivity(a);
              setSidebarOpen(true);
              goToRoute(routeForActivity(a));
            }}
            containerCount={containers.length}
            prCount={prs.length}
            problemCount={problemCount}
            onOpenCommandPalette={() => setPaletteOpen(true)}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
          />

          <Routes>
            <Route path="/" element={<Navigate to="/chats" replace />} />
            <Route
              path="/chats"
              element={
                <ChatsRoute
                  containers={containers}
                  activeContainer={active}
                  activeContainerId={activeTabId}
                  onSelectContainer={openContainer}
                  activeSessions={activeSessions}
                  namedSessions={namedSessions}
                  activeSessionId={activeSessionId}
                  activeSplitSessionId={activeSplitSessionId}
                  onFocusSession={focusSession}
                  onCloseSession={closeSession}
                  onNewSession={newSession}
                  onRenameSession={renameSession}
                  onReorderSession={reorderSession}
                  onSetSplitSession={setActiveSplitSession}
                  onClearSplitSession={clearActiveSplitSession}
                  activeFsPath={activeFsPath}
                  onFsPathChange={setActiveFsPath}
                  openedFile={openedFile}
                  onOpenFile={setOpenedFile}
                  openedDiffEvent={openedDiffEvent}
                  onOpenDiffEvent={setOpenedDiffEvent}
                />
              }
            />
            <Route
              path="/library"
              element={
                <LibraryRoute
                  containers={containers}
                  activeContainerId={activeTabId}
                  onSelectContainer={openContainer}
                />
              }
            />
            <Route
              path="/files"
              element={
                <FilesRoute
                  containers={containers}
                  activeContainerId={activeTabId}
                  onSelectContainer={openContainer}
                  subActivity={
                    activity === "files" ||
                    activity === "scm" ||
                    activity === "problems" ||
                    activity === "keybindings"
                      ? activity
                      : "files"
                  }
                  onSubActivityChange={setActivity}
                  activeFsPath={activeFsPath}
                  onFsPathChange={setActiveFsPath}
                  openedFile={openedFile}
                  onOpenFile={setOpenedFile}
                />
              }
            />
            <Route path="/settings" element={<SettingsRoute />} />
            <Route path="*" element={<Navigate to="/chats" replace />} />
          </Routes>
        </div>

        {isPhone && (
          <PhoneTabBar
            activeTab={activityToPhoneTab(activity)}
            onTabChange={(t) => {
              const a = phoneTabToActivity(t);
              setActivity(a);
              setSidebarOpen(true);
              goToRoute(routeForActivity(a));
            }}
            visible={!phoneInChatDetail}
          />
        )}

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
            goToRoute(routeForActivity(a));
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
