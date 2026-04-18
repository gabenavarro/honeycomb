/** Narrow left rail — the VSCode/Cursor activity bar. Selecting an icon
 * changes what the primary sidebar shows. */

import {
  AlertCircle,
  Box,
  FolderTree,
  GitBranch,
  Keyboard,
  Search,
  Settings,
  SquareStack,
} from "lucide-react";

export type Activity =
  | "containers"
  | "gitops"
  | "search"
  | "settings"
  | "problems"
  | "scm"
  | "keybindings"
  | "files";

interface Props {
  active: Activity;
  onChange: (a: Activity) => void;
  containerCount: number;
  prCount: number;
  problemCount?: number;
  onOpenCommandPalette: () => void;
  /** M22.2 — double-click any activity icon toggles the sidebar. The
   * single-click ``onChange`` still fires; double-click is an
   * additive "also collapse" gesture matching VSCode. */
  onToggleSidebar?: () => void;
}

interface Item {
  id: Activity;
  icon: React.ReactNode;
  label: string;
  shortcut: string;
  badgeFor: (counts: {
    containerCount: number;
    prCount: number;
    problemCount: number;
  }) => number | null;
}

const ITEMS: Item[] = [
  {
    id: "containers",
    icon: <Box size={18} />,
    label: "Containers",
    shortcut: "Ctrl+Shift+C",
    badgeFor: ({ containerCount }) => (containerCount > 0 ? containerCount : null),
  },
  {
    id: "scm",
    icon: <SquareStack size={18} />,
    label: "Source Control",
    shortcut: "Ctrl+Shift+S",
    badgeFor: () => null,
  },
  {
    id: "files",
    icon: <FolderTree size={18} />,
    label: "Files",
    shortcut: "Ctrl+Shift+F",
    badgeFor: () => null,
  },
  {
    id: "gitops",
    icon: <GitBranch size={18} />,
    label: "Git Ops",
    shortcut: "Ctrl+Shift+G",
    badgeFor: ({ prCount }) => (prCount > 0 ? prCount : null),
  },
  {
    id: "problems",
    icon: <AlertCircle size={18} />,
    label: "Problems",
    shortcut: "Ctrl+Shift+P",
    badgeFor: ({ problemCount }) => (problemCount > 0 ? problemCount : null),
  },
  {
    id: "search",
    icon: <Search size={18} />,
    label: "Command Palette",
    shortcut: "Ctrl+K",
    badgeFor: () => null,
  },
];

export function ActivityBar({
  active,
  onChange,
  containerCount,
  prCount,
  problemCount = 0,
  onOpenCommandPalette,
  onToggleSidebar,
}: Props) {
  return (
    <nav
      aria-label="Activity bar"
      className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-[#2b2b2b] bg-[#181818] py-2"
    >
      <ul className="flex flex-col gap-1">
        {ITEMS.map((item) => {
          const isActive = active === item.id;
          const badge = item.badgeFor({ containerCount, prCount, problemCount });
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => {
                  if (item.id === "search") {
                    onOpenCommandPalette();
                  } else {
                    onChange(item.id);
                  }
                }}
                onDoubleClick={() => onToggleSidebar?.()}
                title={`${item.label} (${item.shortcut}) — double-click to toggle sidebar`}
                aria-label={item.label}
                aria-pressed={isActive}
                className={`relative flex h-10 w-10 items-center justify-center rounded transition-colors ${
                  isActive
                    ? "bg-[#2a2d2e] text-[#e7e7e7] before:absolute before:top-2 before:left-0 before:h-6 before:w-0.5 before:bg-[#0078d4]"
                    : "text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
                }`}
              >
                {item.icon}
                {badge !== null && (
                  <span className="absolute top-1 right-1 rounded-full bg-[#0078d4] px-1 text-[8px] leading-none font-bold text-white">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <ul className="flex flex-col gap-1">
        <li>
          <button
            type="button"
            onClick={() => onChange("keybindings")}
            onDoubleClick={() => onToggleSidebar?.()}
            title="Keybindings — double-click to toggle sidebar"
            aria-label="Keybindings"
            aria-pressed={active === "keybindings"}
            className={`flex h-10 w-10 items-center justify-center rounded transition-colors ${
              active === "keybindings"
                ? "bg-[#2a2d2e] text-[#e7e7e7]"
                : "text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
            }`}
          >
            <Keyboard size={18} />
          </button>
        </li>
        <li>
          <button
            type="button"
            onClick={() => onChange("settings")}
            onDoubleClick={() => onToggleSidebar?.()}
            title="Settings — double-click to toggle sidebar"
            aria-label="Settings"
            aria-pressed={active === "settings"}
            className={`flex h-10 w-10 items-center justify-center rounded transition-colors ${
              active === "settings"
                ? "bg-[#2a2d2e] text-[#e7e7e7]"
                : "text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
            }`}
          >
            <Settings size={18} />
          </button>
        </li>
      </ul>
    </nav>
  );
}
