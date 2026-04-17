/** Default keybinding table. Kept separate from the editor component
 * so Fast Refresh can hot-reload the UI without reloading constants. */

export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  "command-palette": "Ctrl+K",
  "toggle-sidebar": "Ctrl+B",
  "toggle-secondary": "Ctrl+J",
  "close-tab": "Ctrl+W",
  "activity-containers": "Ctrl+Shift+C",
  "activity-gitops": "Ctrl+Shift+G",
};
