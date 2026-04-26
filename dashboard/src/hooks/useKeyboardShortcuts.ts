/** Global keyboard shortcuts — VSCode/Cursor-inspired (M32 update).
 *
 * Bound at the document level so focus inside an input still works:
 * Cmd+K from a terminal prompt still opens the palette. Shortcuts
 * that would compete with browser text editing (Ctrl+A, Ctrl+F) are
 * NOT bound.
 *
 * M32 changes:
 *   - ⌘1 / ⌘2 / ⌘3 → route switch (Chats / Library / Files)
 *   - ⌘,           → route switch (Settings)
 *   - Alt+1..Alt+9 → focus Nth open container tab (was ⌘1-⌘9)
 *   - ⌘⇧C / ⌘⇧G    → REMOVED (Activity-group entries deleted in M32
 *                    Task 7; route shortcuts replace them)
 */

import { useEffect } from "react";

import type { RouteId } from "../lib/routes";

export interface ShortcutBindings {
  onCommandPalette: () => void;
  onToggleSidebar: () => void;
  onToggleSecondary: () => void;
  onCloseActiveTab: () => void;
  onFocusTabByIndex: (idx: number) => void;
  /** M32 — switch to one of the four top-level routes. */
  onActivateRoute: (route: RouteId) => void;
  /** M21 M — open the shortcut cheat-sheet overlay. Triggered by the
   * unmodified ``?`` key anywhere outside an input element. */
  onShowHelp?: () => void;
}

export function useKeyboardShortcuts(bindings: ShortcutBindings): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Bare ``?`` (Shift+/) opens the cheat sheet. Skip when focus is
      // in a text input / textarea / contenteditable so typing a real
      // question mark works.
      if (!mod && e.key === "?" && bindings.onShowHelp) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        const editing =
          tag === "INPUT" || tag === "TEXTAREA" || (target !== null && target.isContentEditable);
        if (!editing) {
          e.preventDefault();
          bindings.onShowHelp();
          return;
        }
      }

      // Alt+1..Alt+9 — focus Nth open container tab. Take this branch
      // BEFORE the modifier check so it's not gated on Cmd/Ctrl.
      if (e.altKey && !e.shiftKey && !mod && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        bindings.onFocusTabByIndex(parseInt(e.key, 10) - 1);
        return;
      }

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
      // Cmd/Ctrl+W — close active tab
      if (e.key.toLowerCase() === "w" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onCloseActiveTab();
        return;
      }

      // Cmd/Ctrl+1 — Chats route
      if (e.key === "1" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onActivateRoute("chats");
        return;
      }
      // Cmd/Ctrl+2 — Library route
      if (e.key === "2" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onActivateRoute("library");
        return;
      }
      // Cmd/Ctrl+3 — Files route
      if (e.key === "3" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onActivateRoute("files");
        return;
      }
      // Cmd/Ctrl+, — Settings route
      if (e.key === "," && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        bindings.onActivateRoute("settings");
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [bindings]);
}
