/** PhoneTabBar — bottom tab bar for phone (<768px) (M36).
 *
 *  Replaces the ActivityBar (visible only at tablet+desktop). 5 tabs
 *  match the desktop activity rail's primary entries:
 *    Chats / Library / Files / Git / More
 *
 *  "More" opens a sheet listing the lower-priority routes
 *  (Settings, Problems). M36 keeps the tab bar at 5 entries — adding
 *  a 6th turns the bar into a horizontal-scroll surface which doesn't
 *  feel native.
 *
 *  Tap targets are 44x44 minimum (iOS HIG).
 *
 *  Hidden in detail views per the M36 spec (composer needs the
 *  vertical real-estate); App.tsx controls visibility via the
 *  `visible` prop.
 */
import type { ReactElement } from "react";

import { BookOpen, FolderOpen, GitBranch, MessageSquare, MoreHorizontal } from "lucide-react";

export type PhoneTab = "chats" | "library" | "files" | "git" | "more";

interface Props {
  activeTab: PhoneTab;
  onTabChange: (tab: PhoneTab) => void;
  visible?: boolean; // default true; hidden in detail views
}

const TABS: { id: PhoneTab; label: string; icon: ReactElement }[] = [
  { id: "chats", label: "Chats", icon: <MessageSquare size={20} aria-hidden="true" /> },
  { id: "library", label: "Library", icon: <BookOpen size={20} aria-hidden="true" /> },
  { id: "files", label: "Files", icon: <FolderOpen size={20} aria-hidden="true" /> },
  { id: "git", label: "Git", icon: <GitBranch size={20} aria-hidden="true" /> },
  { id: "more", label: "More", icon: <MoreHorizontal size={20} aria-hidden="true" /> },
];

export function PhoneTabBar({ activeTab, onTabChange, visible = true }: Props) {
  if (!visible) return null;
  return (
    <nav
      aria-label="Phone bottom navigation"
      className="border-edge bg-pane pb-safe-bottom fixed right-0 bottom-0 left-0 z-30 flex border-t"
    >
      {TABS.map((t) => {
        const active = t.id === activeTab;
        // Active uses text-primary (font-semibold) + a top accent bar
        // for visual emphasis. Pure text-accent (#b8541c on #f7f1e3 in
        // light theme) fails WCAG AA contrast at 10px (4.31:1 < 4.5).
        // The top bar carries the accent color; the label stays high-
        // contrast.
        return (
          <button
            key={t.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onTabChange(t.id)}
            className={`relative flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] transition-colors ${
              active ? "text-primary font-semibold" : "text-secondary"
            }`}
          >
            {active && (
              <span aria-hidden="true" className="bg-accent absolute inset-x-0 top-0 h-0.5" />
            )}
            {t.icon}
            <span>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
