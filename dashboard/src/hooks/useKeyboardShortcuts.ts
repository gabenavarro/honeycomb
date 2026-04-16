/** Global keyboard shortcuts — VSCode/Cursor-inspired.
 *
 * We bind at the document level so focus inside an input still works:
 * Cmd+K from a terminal prompt still opens the palette. Shortcuts that
 * would compete with browser text editing (Ctrl+A, Ctrl+F) are NOT bound.
 */

import { useEffect } from "react";

export interface ShortcutBindings {
  onCommandPalette: () => void;
  onToggleSidebar: () => void;
  onToggleSecondary: () => void;
  onCloseActiveTab: () => void;
  onFocusTabByIndex: (idx: number) => void;
  onActivityContainers: () => void;
  onActivityGitOps: () => void;
}

export function useKeyboardShortcuts(bindings: ShortcutBindings): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // Cmd/Ctrl+K — command palette
      if (e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onCommandPalette();
        return;
      }
      // Cmd/Ctrl+B — toggle primary sidebar
      if (e.key.toLowerCase() === "b" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onToggleSidebar();
        return;
      }
      // Cmd/Ctrl+` — toggle secondary panel (backtick)
      if (e.key === "`" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onToggleSecondary();
        return;
      }
      // Cmd/Ctrl+W — close active tab (preventDefault stops the browser
      // from closing the whole window)
      if (e.key.toLowerCase() === "w" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onCloseActiveTab();
        return;
      }
      // Cmd/Ctrl+Shift+C — Containers activity
      if (e.key.toLowerCase() === "c" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onActivityContainers();
        return;
      }
      // Cmd/Ctrl+Shift+G — Git Ops activity
      if (e.key.toLowerCase() === "g" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onActivityGitOps();
        return;
      }
      // Cmd/Ctrl+1..9 — focus Nth open container tab
      if (/^[1-9]$/.test(e.key) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onFocusTabByIndex(parseInt(e.key, 10) - 1);
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [bindings]);
}
