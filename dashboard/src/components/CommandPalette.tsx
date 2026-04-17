/** Cmd+K / Ctrl+K palette — built on cmdk + Radix Dialog (M8).
 *
 * cmdk owns the keyboard model (arrows, Enter, grouping, fuzzy filter)
 * and the aria-combobox wiring. We layer it inside a Radix Dialog so
 * focus is trapped, restored on close, and the overlay announces a
 * named "Command palette" region to screen readers.
 *
 * Command list construction (containers × actions, activity shortcuts,
 * discover entry) is unchanged from the pre-M8 hand-rolled palette —
 * only the rendering + keyboard plumbing moved to the primitives.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useMemo } from "react";

import type { ContainerRecord } from "../lib/types";
import type { Activity } from "./ActivityBar";

interface PaletteCommand {
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
  const commands: PaletteCommand[] = useMemo(() => {
    const items: PaletteCommand[] = [];

    for (const c of containers) {
      items.push({
        id: `focus:${c.id}`,
        title: `Open: ${c.project_name}`,
        subtitle: `${c.workspace_folder} · ${c.container_status}`,
        group: "Containers",
        run: () => onFocusContainer(c.id),
      });
    }
    for (const c of containers) {
      items.push({
        id: `close:${c.id}`,
        title: `Close tab: ${c.project_name}`,
        group: "Containers",
        run: () => onCloseContainer(c.id),
      });
    }
    for (const c of containers) {
      items.push({
        id: `claude:${c.id}`,
        title: `Start Claude session in ${c.project_name}`,
        group: "Sessions",
        run: () => onNewClaudeSession(c.id),
      });
    }

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

  // Group commands for cmdk.Group rendering. Order of groups here is
  // the visual order in the palette.
  const groups: { label: PaletteCommand["group"]; items: PaletteCommand[] }[] = useMemo(() => {
    const labels: PaletteCommand["group"][] = ["Containers", "Sessions", "Activity", "Discover"];
    return labels
      .map((label) => ({ label, items: commands.filter((c) => c.group === label) }))
      .filter((g) => g.items.length > 0);
  }, [commands]);

  const byId = useMemo(() => {
    const map = new Map<string, PaletteCommand>();
    for (const c of commands) map.set(c.id, c);
    return map;
  }, [commands]);

  const handleSelect = (id: string) => {
    const cmd = byId.get(id);
    if (cmd) {
      cmd.run();
      onClose();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/50" />
        <Dialog.Content
          className="fixed top-[15%] left-1/2 z-[100] w-full max-w-xl -translate-x-1/2 rounded-lg border border-[#454545] bg-[#252526] shadow-2xl outline-none"
          aria-label="Command palette"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command
            // Filter uses cmdk's built-in fuzzy scorer. We include the
            // title, subtitle, and group in the keywords so typing a
            // group name still works.
            filter={(value, search, keywords) => {
              const haystack = [value, ...(keywords ?? [])].join(" ").toLowerCase();
              const needle = search.trim().toLowerCase();
              if (!needle) return 1;
              // Simple subsequence match scaled by match density —
              // good enough for a local palette, no external lib.
              let i = 0;
              for (const ch of needle) {
                i = haystack.indexOf(ch, i);
                if (i < 0) return 0;
                i += 1;
              }
              return 1;
            }}
            loop
          >
            <div className="flex items-center gap-2 border-b border-[#3a3a3a] px-3 py-2">
              <Search size={14} className="text-[#858585]" aria-hidden="true" />
              <Command.Input
                placeholder="Type a command or container name…"
                className="flex-1 bg-transparent text-sm text-[#e7e7e7] outline-none placeholder:text-[#666]"
                autoFocus
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto py-1">
              <Command.Empty className="px-3 py-2 text-xs text-[#858585]">No matches</Command.Empty>
              {groups.map((group) => (
                <Command.Group
                  key={group.label}
                  heading={group.label}
                  className="px-1 py-0.5 text-[10px] text-[#858585] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:uppercase"
                >
                  {group.items.map((cmd) => (
                    <Command.Item
                      key={cmd.id}
                      value={cmd.title}
                      keywords={[cmd.subtitle ?? "", cmd.group]}
                      onSelect={() => handleSelect(cmd.id)}
                      className="flex cursor-pointer items-center justify-between rounded px-3 py-1.5 text-xs text-[#cccccc] data-[selected=true]:bg-[#094771] data-[selected=true]:text-white"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{cmd.title}</div>
                        {cmd.subtitle && (
                          <div className="truncate text-[10px] text-[#858585]">{cmd.subtitle}</div>
                        )}
                      </div>
                      {cmd.shortcut && (
                        <kbd className="ml-3 shrink-0 rounded border border-[#555] px-1.5 py-0.5 text-[10px] text-[#858585]">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
