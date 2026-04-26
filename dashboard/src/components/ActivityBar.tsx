/** Activity rail (M32 rebuild).
 *
 * Four entries — Chats / Library / Files / Settings. Settings is
 * bottom-anchored. Chats shows a "reviews" counter (count of open
 * PRs from the GitOps panel) when > 0.
 *
 * The Activity union (legacy data layer) stays unchanged: the rail
 * still emits Activity values to onChange so App.tsx's state
 * machine doesn't need to know about RouteId during the bridge.
 *
 * Mapping:
 *   - Chats    → "containers"  (active when activity === "containers" || "search" || "gitops")
 *   - Library  → "diff-events"
 *   - Files    → "files"       (active when activity ∈ {files, scm, problems, keybindings})
 *   - Settings → "settings"
 */

import { FolderTree, MessagesSquare, Settings, Sparkles } from "lucide-react";

export type Activity =
  | "containers"
  | "gitops"
  | "search"
  | "settings"
  | "problems"
  | "scm"
  | "keybindings"
  | "files"
  | "diff-events";

interface Props {
  active: Activity;
  onChange: (a: Activity) => void;
  containerCount: number;
  prCount: number;
  problemCount?: number;
  onOpenCommandPalette: () => void;
  /** Double-click toggles the sidebar open/closed (M22.2 gesture). */
  onToggleSidebar?: () => void;
}

interface RailEntry {
  id: "chats" | "library" | "files" | "settings";
  label: string;
  shortcut: string;
  icon: React.ReactNode;
  /** Activity value emitted to onChange when clicked. */
  emits: Activity;
  /** True when this entry should appear "pressed" given the current activity. */
  isActive: (a: Activity) => boolean;
  /** Numeric badge shown over the icon, or null. */
  badgeFor: (counts: {
    containerCount: number;
    prCount: number;
    problemCount: number;
  }) => number | null;
}

const TOP_ENTRIES: readonly RailEntry[] = [
  {
    id: "chats",
    label: "Chats",
    shortcut: "Ctrl+1",
    icon: <MessagesSquare size={18} />,
    emits: "containers",
    isActive: (a) => a === "containers" || a === "gitops" || a === "search",
    badgeFor: ({ prCount }) => (prCount > 0 ? prCount : null),
  },
  {
    id: "library",
    label: "Library",
    shortcut: "Ctrl+2",
    icon: <Sparkles size={18} />,
    emits: "diff-events",
    isActive: (a) => a === "diff-events",
    badgeFor: () => null,
  },
  {
    id: "files",
    label: "Files",
    shortcut: "Ctrl+3",
    icon: <FolderTree size={18} />,
    emits: "files",
    isActive: (a) => a === "files" || a === "scm" || a === "problems" || a === "keybindings",
    badgeFor: ({ problemCount }) => (problemCount > 0 ? problemCount : null),
  },
];

const SETTINGS_ENTRY: RailEntry = {
  id: "settings",
  label: "Settings",
  shortcut: "Ctrl+,",
  icon: <Settings size={18} />,
  emits: "settings",
  isActive: (a) => a === "settings",
  badgeFor: () => null,
};

export function ActivityBar({
  active,
  onChange,
  containerCount,
  prCount,
  problemCount = 0,
  onOpenCommandPalette,
  onToggleSidebar,
}: Props) {
  void onOpenCommandPalette; // ⌘K is now triggered via global shortcut, not the rail; reserved for a future "Search" affordance.
  return (
    <nav
      aria-label="Activity bar"
      className="border-edge bg-pane flex w-12 shrink-0 flex-col items-center justify-between border-r py-2"
    >
      <ul className="flex flex-col gap-1">
        {TOP_ENTRIES.map((item) => (
          <ActivityButton
            key={item.id}
            item={item}
            active={active}
            counts={{ containerCount, prCount, problemCount }}
            onChange={onChange}
            onToggleSidebar={onToggleSidebar}
          />
        ))}
      </ul>
      <ul className="flex flex-col gap-1">
        <ActivityButton
          item={SETTINGS_ENTRY}
          active={active}
          counts={{ containerCount, prCount, problemCount }}
          onChange={onChange}
          onToggleSidebar={onToggleSidebar}
        />
      </ul>
    </nav>
  );
}

function ActivityButton({
  item,
  active,
  counts,
  onChange,
  onToggleSidebar,
}: {
  item: RailEntry;
  active: Activity;
  counts: { containerCount: number; prCount: number; problemCount: number };
  onChange: (a: Activity) => void;
  onToggleSidebar?: () => void;
}) {
  const isActive = item.isActive(active);
  const badge = item.badgeFor(counts);
  return (
    <li>
      <button
        type="button"
        onClick={() => onChange(item.emits)}
        onDoubleClick={() => onToggleSidebar?.()}
        title={`${item.label} (${item.shortcut}) — double-click to toggle sidebar`}
        aria-label={item.label}
        aria-pressed={isActive}
        className={`relative flex h-10 w-10 items-center justify-center rounded transition-colors ${
          isActive
            ? "bg-chip text-primary before:bg-accent before:absolute before:top-2 before:left-0 before:h-6 before:w-0.5"
            : "text-secondary hover:bg-chip hover:text-primary"
        }`}
      >
        {item.icon}
        {badge !== null && (
          <span className="bg-accent absolute top-1 right-1 rounded-full px-1 text-[8px] leading-none font-bold text-white">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </button>
    </li>
  );
}
