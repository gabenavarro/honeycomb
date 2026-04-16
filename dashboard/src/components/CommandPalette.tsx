/** Cmd+K / Ctrl+K palette — the VSCode/Cursor quick-switch.
 * Lightweight: substring match, no fuzzy algorithm, no new deps. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { ContainerRecord } from "../lib/types";
import type { Activity } from "./ActivityBar";

export interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  shortcut?: string;
  group: "Containers" | "Activity" | "Sessions" | "Discover";
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  containers: ContainerRecord[];
  onFocusContainer: (id: number) => void;
  onCloseContainer: (id: number) => void;
  onNewClaudeSession: (id: number) => void;
  onActivity: (a: Activity) => void;
  onOpenProvisioner: () => void;
}

export function CommandPalette({
  open,
  onClose,
  containers,
  onFocusContainer,
  onCloseContainer,
  onNewClaudeSession,
  onActivity,
  onOpenProvisioner,
}: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // Delay focus until the modal has painted; otherwise some browsers
      // swallow the first keystroke.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands: PaletteCommand[] = useMemo(() => {
    const items: PaletteCommand[] = [];

    // Containers — focus
    for (const c of containers) {
      items.push({
        id: `focus:${c.id}`,
        title: `Open: ${c.project_name}`,
        subtitle: `${c.workspace_folder} · ${c.container_status}`,
        group: "Containers",
        run: () => onFocusContainer(c.id),
      });
    }
    // Containers — close
    for (const c of containers) {
      items.push({
        id: `close:${c.id}`,
        title: `Close tab: ${c.project_name}`,
        group: "Containers",
        run: () => onCloseContainer(c.id),
      });
    }
    // Sessions — new Claude
    for (const c of containers) {
      items.push({
        id: `claude:${c.id}`,
        title: `Start Claude session in ${c.project_name}`,
        group: "Sessions",
        run: () => onNewClaudeSession(c.id),
      });
    }

    // Activity
    items.push(
      {
        id: "act:containers",
        title: "Show Containers sidebar",
        shortcut: "Ctrl+Shift+C",
        group: "Activity",
        run: () => onActivity("containers"),
      },
      {
        id: "act:gitops",
        title: "Show Git Ops sidebar",
        shortcut: "Ctrl+Shift+G",
        group: "Activity",
        run: () => onActivity("gitops"),
      },
    );

    // Discover / provision
    items.push({
      id: "discover:new",
      title: "Register a new devcontainer…",
      subtitle: "Opens the Discover / Manual wizard",
      group: "Discover",
      run: onOpenProvisioner,
    });

    return items;
  }, [
    containers,
    onFocusContainer,
    onCloseContainer,
    onNewClaudeSession,
    onActivity,
    onOpenProvisioner,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      return (
        c.title.toLowerCase().includes(q) ||
        (c.subtitle ?? "").toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q)
      );
    });
  }, [query, commands]);

  // Keep cursor in bounds as the result set shrinks.
  useEffect(() => {
    setCursor((prev) => Math.min(prev, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const run = useCallback(
    (cmd: PaletteCommand) => {
      cmd.run();
      onClose();
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 p-4 pt-20"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-xl rounded-lg border border-[#454545] bg-[#252526] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-2 border-b border-[#3a3a3a] px-3 py-2">
          <Search size={14} className="text-[#858585]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(filtered.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const cmd = filtered[cursor];
                if (cmd) run(cmd);
              }
            }}
            placeholder="Type a command or container name…"
            className="flex-1 bg-transparent text-sm text-[#e7e7e7] outline-none placeholder:text-[#666]"
            aria-label="Command palette input"
          />
        </div>
        <ul
          role="listbox"
          className="max-h-80 overflow-y-auto py-1"
          aria-label="Command palette results"
        >
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-xs text-[#858585]">No matches</li>
          )}
          {filtered.map((cmd, idx) => (
            <li
              key={cmd.id}
              role="option"
              aria-selected={idx === cursor}
              onMouseEnter={() => setCursor(idx)}
              onClick={() => run(cmd)}
              className={`flex cursor-pointer items-center justify-between px-3 py-1.5 text-xs ${
                idx === cursor ? "bg-[#094771] text-white" : "text-[#cccccc]"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{cmd.title}</div>
                {cmd.subtitle && (
                  <div className="truncate text-[10px] text-[#858585]">{cmd.subtitle}</div>
                )}
              </div>
              <div className="ml-3 flex shrink-0 items-center gap-2 text-[10px] text-[#858585]">
                <span>{cmd.group}</span>
                {cmd.shortcut && (
                  <kbd className="rounded border border-[#555] px-1.5 py-0.5">{cmd.shortcut}</kbd>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
