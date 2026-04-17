/** Load persisted keybinding overrides from the hub (M10).
 *
 * The full binding set is ``DEFAULT_KEYBINDINGS`` merged with whatever
 * ``GET /api/keybindings`` returns. Components that care about the
 * active shortcut for a command look it up via the returned record.
 *
 * The hook intentionally keeps a simple shape — merging happens here
 * so every consumer gets a resolved map without having to know about
 * the defaults.
 */

import { useQuery } from "@tanstack/react-query";

import { getKeybindings } from "../lib/api";
import { DEFAULT_KEYBINDINGS } from "../lib/keybindings";

export function useKeybindings(): Record<string, string> {
  const { data } = useQuery({
    queryKey: ["keybindings"],
    queryFn: getKeybindings,
    // Keybindings rarely change; 60s stale + no refetch-on-focus.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return { ...DEFAULT_KEYBINDINGS, ...(data?.bindings ?? {}) };
}
