/** Keyboard cheat-sheet overlay (M21 M).
 *
 * Pressing ``?`` (unmodified, outside an input) opens this Radix
 * Dialog listing every shortcut the dashboard currently binds. Pulls
 * from ``useKeybindings`` so user overrides from
 * ``~/.config/honeycomb/keybindings.json`` show the right chord.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { useKeybindings } from "../hooks/useKeybindings";

interface Props {
  open: boolean;
  onClose: () => void;
}

// Static fallback metadata — keybindings returned by the hook are
// command-id → chord strings. Human-readable descriptions live here so
// the cheat sheet tells a coherent story.
const COMMAND_CAPTIONS: Record<string, string> = {
  "command-palette": "Open command palette",
  "toggle-sidebar": "Toggle primary sidebar",
  "toggle-secondary": "Toggle secondary panel (reserved)",
  "close-tab": "Close active container tab",
  "activity-containers": "Switch to Containers activity",
  "activity-gitops": "Switch to Git Ops activity",
};

const EXTRA_HELP: [string, string][] = [
  ["Ctrl+1…9", "Focus the Nth open container tab"],
  ["?", "Show this cheat sheet"],
  ["Double-click tab name", "Rename session"],
  ["Middle-click tab", "Close tab"],
  ["Drag session tab", "Reorder"],
];

export function HelpOverlay({ open, onClose }: Props) {
  const keybindings = useKeybindings();
  const entries = Object.entries(keybindings)
    .filter(([cmd]) => COMMAND_CAPTIONS[cmd])
    .map(([cmd, chord]) => [chord, COMMAND_CAPTIONS[cmd]] as [string, string]);

  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-[#2b2b2b] bg-[#1e1e1e] p-0 shadow-2xl outline-none"
          aria-describedby={undefined}
        >
          <header className="flex items-center justify-between border-b border-[#2b2b2b] px-4 py-2">
            <Dialog.Title className="text-xs font-semibold tracking-wider text-[#858585] uppercase">
              Keyboard shortcuts
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded p-1 text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
                aria-label="Close cheat sheet"
              >
                <X size={12} />
              </button>
            </Dialog.Close>
          </header>
          <div className="max-h-[60vh] overflow-y-auto p-4 text-[11px]">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
              {entries.map(([chord, caption]) => (
                <ChordRow key={caption} chord={chord} caption={caption} />
              ))}
              {EXTRA_HELP.map(([chord, caption]) => (
                <ChordRow key={caption} chord={chord} caption={caption} />
              ))}
            </dl>
            <p className="mt-4 text-[10px] text-[#606060]">
              Edit overrides in the Keybindings activity; they persist to{" "}
              <code>~/.config/honeycomb/keybindings.json</code>.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ChordRow({ chord, caption }: { chord: string; caption: string }) {
  return (
    <>
      <dt>
        <kbd className="rounded border border-[#444] bg-[#2a2a2a] px-1.5 py-0.5 font-mono text-[10px] text-[#e7e7e7]">
          {chord}
        </kbd>
      </dt>
      <dd className="text-[#c0c0c0]">{caption}</dd>
    </>
  );
}
