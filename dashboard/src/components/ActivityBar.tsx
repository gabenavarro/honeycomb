/** Narrow left rail — the VSCode/Cursor activity bar. Selecting an icon
 * changes what the primary sidebar shows. */

import { Box, GitBranch, Search, Settings } from "lucide-react";

export type Activity = "containers" | "gitops" | "search" | "settings";

interface Props {
  active: Activity;
  onChange: (a: Activity) => void;
  containerCount: number;
  prCount: number;
  onOpenCommandPalette: () => void;
}

interface Item {
  id: Activity;
  icon: React.ReactNode;
  label: string;
  shortcut: string;
  badgeFor: (counts: { containerCount: number; prCount: number }) => number | null;
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
    id: "gitops",
    icon: <GitBranch size={18} />,
    label: "Git Ops",
    shortcut: "Ctrl+Shift+G",
    badgeFor: ({ prCount }) => (prCount > 0 ? prCount : null),
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
  onOpenCommandPalette,
}: Props) {
  return (
    <nav
      aria-label="Activity bar"
      className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-[#2b2b2b] bg-[#181818] py-2"
    >
      <ul className="flex flex-col gap-1">
        {ITEMS.map((item) => {
          const isActive = active === item.id;
          const badge = item.badgeFor({ containerCount, prCount });
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
                title={`${item.label} (${item.shortcut})`}
                aria-label={item.label}
                aria-pressed={isActive}
                className={`relative flex h-10 w-10 items-center justify-center rounded transition-colors ${
                  isActive
                    ? "bg-[#2a2d2e] text-[#e7e7e7] before:absolute before:left-0 before:top-2 before:h-6 before:w-0.5 before:bg-[#0078d4]"
                    : "text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
                }`}
              >
                {item.icon}
                {badge !== null && (
                  <span className="absolute right-1 top-1 rounded-full bg-[#0078d4] px-1 text-[8px] font-bold leading-none text-white">
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
            onClick={() => onChange("settings")}
            title="Settings"
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
