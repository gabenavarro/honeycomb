/** Cmd+K / Ctrl+K palette (M8; M23 adds file: mode + suggestions).
 *
 * cmdk owns the keyboard model + fuzzy filter. We layer:
 *
 * - ``mode = "command" | "file"``: prefix-driven. ``file:<query>``
 *   flips to file mode, ``>`` remains an explicit commands-only
 *   escape, ``?`` prints a help card in place of the list.
 * - Suggestions group at the top of command mode, parsed from
 *   manifest files at the active container's WORKDIR.
 * - File group in file mode, backed by a flat walk of the active
 *   container's filesystem.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useContainerFileIndex } from "../hooks/useContainerFileIndex";
import { useContainerSuggestions } from "../hooks/useContainerSuggestions";
import { useTheme } from "../lib/theme";
import type { ContainerRecord } from "../lib/types";
import type { Activity } from "./ActivityBar";

type PaletteMode = "command" | "file";

interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  shortcut?: string;
  group: "Containers" | "Activity" | "Sessions" | "Discover" | "Suggestions" | "Appearance";
  run: () => void;
}

interface FileItem {
  id: string;
  path: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  containers: ContainerRecord[];
  /** Used to title the suggestions group + scope the file walk. */
  activeContainerId: number | null;
  /** WORKDIR for the active container — empty string if unknown. */
  activeWorkdir: string;
  onFocusContainer: (id: number) => void;
  onCloseContainer: (id: number) => void;
  onNewClaudeSession: (id: number) => void;
  onActivity: (a: Activity) => void;
  onOpenProvisioner: () => void;
  /** Open a file from the walk index in the viewer pane. */
  onOpenFile: (path: string) => void;
  /** Pre-type a suggestion command into the active container's PTY. */
  onRunSuggestion: (command: string) => void;
}

// Strip the mode prefix off the raw input so cmdk scores against the
// actual query. Returns the normalised (mode, search) pair.
function parseInput(raw: string): { mode: PaletteMode; search: string; showHelp: boolean } {
  if (raw === "?") return { mode: "command", search: "", showHelp: true };
  if (raw.startsWith("file:"))
    return { mode: "file", search: raw.slice("file:".length), showHelp: false };
  if (raw.startsWith(">")) return { mode: "command", search: raw.slice(1), showHelp: false };
  return { mode: "command", search: raw, showHelp: false };
}

export function CommandPalette({
  open,
  onClose,
  containers,
  activeContainerId,
  activeWorkdir,
  onFocusContainer,
  onCloseContainer,
  onNewClaudeSession,
  onActivity,
  onOpenProvisioner,
  onOpenFile,
  onRunSuggestion,
}: Props) {
  const [rawInput, setRawInput] = useState("");
  const { mode, search, showHelp } = parseInput(rawInput);

  const themeApi = useTheme();
  const themeRef = useRef(themeApi);
  useEffect(() => {
    themeRef.current = themeApi;
  }, [themeApi]);

  // Global keyboard shortcuts ⌘⇧L / ⌘⇧D / ⌘⇧S (active whether or not the palette is open)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "l") {
        e.preventDefault();
        themeRef.current.setPreference("light");
      } else if (k === "d") {
        e.preventDefault();
        themeRef.current.setPreference("dark");
      } else if (k === "s") {
        e.preventDefault();
        themeRef.current.setPreference("system");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const fileIndex = useContainerFileIndex(activeContainerId, {
    enabled: mode === "file" && activeContainerId !== null,
  });
  const suggestions = useContainerSuggestions(activeContainerId, activeWorkdir);

  const activeName = useMemo(
    () => containers.find((c) => c.id === activeContainerId)?.project_name ?? null,
    [containers, activeContainerId],
  );

  const commands: PaletteCommand[] = useMemo(() => {
    const items: PaletteCommand[] = [];
    for (const s of suggestions) {
      items.push({
        id: s.id,
        title: s.title,
        subtitle: s.subtitle,
        group: "Suggestions",
        run: () => onRunSuggestion(s.command),
      });
    }
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
    items.push(
      {
        id: "theme:light",
        title: "Switch to Light theme",
        subtitle: "Warm Workshop palette",
        shortcut: "⌘ ⇧ L",
        group: "Appearance",
        run: () => themeRef.current.setPreference("light"),
      },
      {
        id: "theme:dark",
        title: "Switch to Dark theme",
        subtitle: "Existing aesthetic",
        shortcut: "⌘ ⇧ D",
        group: "Appearance",
        run: () => themeRef.current.setPreference("dark"),
      },
      {
        id: "theme:system",
        title: "Use System theme",
        subtitle: "Follow OS preference",
        shortcut: "⌘ ⇧ S",
        group: "Appearance",
        run: () => themeRef.current.setPreference("system"),
      },
    );
    return items;
  }, [
    containers,
    suggestions,
    onFocusContainer,
    onCloseContainer,
    onNewClaudeSession,
    onActivity,
    onOpenProvisioner,
    onRunSuggestion,
  ]);

  // Top-to-bottom group order. Suggestions first — they're the most
  // contextual. Files show only in file mode via a separate branch.
  const groupOrder: PaletteCommand["group"][] = useMemo(
    () =>
      (activeName
        ? ["Suggestions", "Containers", "Sessions", "Activity", "Discover", "Appearance"]
        : ["Containers", "Sessions", "Activity", "Discover", "Appearance"]) as PaletteCommand["group"][],
    [activeName],
  );

  const groups = useMemo(
    () =>
      groupOrder
        .map((label) => ({ label, items: commands.filter((c) => c.group === label) }))
        .filter((g) => g.items.length > 0),
    [commands, groupOrder],
  );

  const byId = useMemo(() => {
    const map = new Map<string, PaletteCommand>();
    for (const c of commands) map.set(c.id, c);
    return map;
  }, [commands]);

  const fileItems: FileItem[] = useMemo(() => {
    return fileIndex.entries
      .filter((e) => e.kind === "file")
      .slice(0, 200)
      .map((e) => ({ id: `file:${e.name}`, path: e.name }));
  }, [fileIndex.entries]);

  const handleSelectCommand = (id: string) => {
    const cmd = byId.get(id);
    if (cmd) {
      cmd.run();
      onClose();
    }
  };

  const handleSelectFile = (path: string) => {
    onOpenFile(path);
    onClose();
  };

  const handleClose = () => {
    setRawInput("");
    onClose();
  };

  const groupHeading = (label: PaletteCommand["group"]): string =>
    label === "Suggestions" && activeName ? `Suggestions for ${activeName}` : label;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : handleClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/50" />
        <Dialog.Content
          className="fixed top-[15%] left-1/2 z-[100] w-full max-w-xl -translate-x-1/2 rounded-lg border border-[#454545] bg-[#252526] shadow-2xl outline-none"
          aria-label="Command palette"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command
            filter={(value, s, keywords) => {
              // Strip mode prefixes so cmdk scores against the real query.
              let stripped = s;
              if (stripped.startsWith("file:")) stripped = stripped.slice("file:".length);
              else if (stripped.startsWith(">")) stripped = stripped.slice(1);
              else if (stripped === "?") stripped = "";
              const haystack = [value, ...(keywords ?? [])].join(" ").toLowerCase();
              const needle = stripped.trim().toLowerCase();
              if (!needle) return 1;
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
                placeholder="Type a command or container name… (file:, >, ?)"
                className="flex-1 bg-transparent text-sm text-[#e7e7e7] outline-none placeholder:text-[#666]"
                autoFocus
                value={rawInput}
                onValueChange={setRawInput}
              />
            </div>
            {showHelp ? (
              <HelpCard />
            ) : mode === "file" ? (
              <Command.List className="max-h-80 overflow-y-auto py-1">
                <Command.Empty className="px-3 py-2 text-xs text-[#858585]">
                  {fileIndex.isLoading
                    ? "Walking filesystem…"
                    : fileIndex.error
                      ? "Walk failed."
                      : "No matches"}
                </Command.Empty>
                {activeContainerId === null && (
                  <p className="px-3 py-2 text-xs text-[#858585]">Open a container first.</p>
                )}
                {fileIndex.error !== null && fileIndex.error !== undefined && (
                  <div className="px-3 py-2 text-xs text-red-400">
                    <p>{String(fileIndex.error)}</p>
                    <button
                      type="button"
                      className="mt-1 underline hover:text-red-300"
                      onClick={() => fileIndex.refetch()}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {fileItems.length > 0 && (
                  <Command.Group
                    heading="Files"
                    className="px-1 py-0.5 text-[10px] text-[#858585] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:uppercase"
                  >
                    {fileItems.map((f) => (
                      <Command.Item
                        key={f.id}
                        value={f.path}
                        keywords={[search]}
                        onSelect={() => handleSelectFile(f.path)}
                        className="flex cursor-pointer items-center justify-between rounded px-3 py-1.5 text-xs text-[#cccccc] data-[selected=true]:bg-[#094771] data-[selected=true]:text-white"
                      >
                        <span className="truncate">{f.path}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {fileIndex.truncated && (
                  <p className="px-3 py-1 text-[10px] text-yellow-500">
                    Showing first 5000 files. Refine with a narrower prefix.
                  </p>
                )}
              </Command.List>
            ) : (
              <Command.List className="max-h-80 overflow-y-auto py-1">
                <Command.Empty className="px-3 py-2 text-xs text-[#858585]">
                  No matches
                </Command.Empty>
                {groups.map((group) => (
                  <Command.Group
                    key={group.label}
                    heading={groupHeading(group.label)}
                    className="px-1 py-0.5 text-[10px] text-[#858585] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:uppercase"
                  >
                    {group.items.map((cmd) => (
                      <Command.Item
                        key={cmd.id}
                        value={cmd.title}
                        keywords={[cmd.subtitle ?? "", cmd.group, search]}
                        onSelect={() => handleSelectCommand(cmd.id)}
                        className="flex cursor-pointer items-center justify-between rounded px-3 py-1.5 text-xs text-[#cccccc] data-[selected=true]:bg-[#094771] data-[selected=true]:text-white"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{cmd.title}</div>
                          {cmd.subtitle && (
                            <div className="truncate text-[10px] text-[#858585]">
                              {cmd.subtitle}
                            </div>
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
            )}
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HelpCard() {
  return (
    <div className="px-4 py-3 text-xs text-[#cccccc]">
      <p className="mb-2 font-semibold text-[#e7e7e7]">Palette prefixes</p>
      <ul className="space-y-1 text-[11px]">
        <li>
          <code className="rounded bg-[#333] px-1">file:&lt;query&gt;</code> — fuzzy-search the
          active container's filesystem. Enter opens the file in the editor.
        </li>
        <li>
          <code className="rounded bg-[#333] px-1">&gt;</code> — explicitly search commands only
          (same as typing nothing).
        </li>
        <li>
          <code className="rounded bg-[#333] px-1">?</code> — this cheat-sheet.
        </li>
      </ul>
    </div>
  );
}
