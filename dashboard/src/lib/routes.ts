/** Route table for M32's four-entry layout shell.
 *
 * The dashboard's URL space is intentionally tiny: four top-level
 * routes (Chats / Library / Files / Settings) that map onto the
 * existing Activity surface. The Activity union stays internally —
 * components below the routing layer still consume it — but the URL
 * is now the source of truth for which one is showing.
 *
 * For each route we record:
 *   - id:        a stable opaque RouteId we use in code + storage
 *   - pathname:  the URL path the BrowserRouter matches
 *   - title:     the human-readable label shown in the rail tooltip
 *                + ⌘K palette
 *   - activity:  the legacy Activity that backs the route's main UI
 *                (some Activities collapse INTO a route — see
 *                routeForActivity below)
 *   - shortcut:  the chord that switches to the route. "Mod" expands
 *                to ⌘ on macOS / Ctrl elsewhere; the keyboard handler
 *                accepts both as M31 already does for theme commands.
 */

import type { Activity } from "../components/ActivityBar";

export type RouteId = "chats" | "library" | "files" | "settings";

export interface RouteSpec {
  id: RouteId;
  pathname: string;
  title: string;
  activity: Activity;
  shortcut: string;
}

export const ROUTES: readonly RouteSpec[] = [
  { id: "chats", pathname: "/chats", title: "Chats", activity: "containers", shortcut: "Mod+1" },
  {
    id: "library",
    pathname: "/library",
    title: "Library",
    activity: "diff-events",
    shortcut: "Mod+2",
  },
  { id: "files", pathname: "/files", title: "Files", activity: "files", shortcut: "Mod+3" },
  {
    id: "settings",
    pathname: "/settings",
    title: "Settings",
    activity: "settings",
    shortcut: "Mod+,",
  },
] as const;

export const ROUTE_IDS: readonly RouteId[] = ROUTES.map((r) => r.id);

export function pathnameForRoute(id: RouteId): string {
  return ROUTES.find((r) => r.id === id)!.pathname;
}

/** Map a URL pathname to a RouteId, falling back to "chats" for
 *  unknown / root paths. Prefix-matches so /library/anything still
 *  resolves to "library". */
export function routeForPathname(pathname: string): RouteId {
  for (const r of ROUTES) {
    if (pathname === r.pathname || pathname.startsWith(`${r.pathname}/`)) return r.id;
  }
  return "chats";
}

export function activityForRoute(id: RouteId): Activity {
  return ROUTES.find((r) => r.id === id)!.activity;
}

/** Map a legacy Activity to the route that owns its UI. Several
 *  activities (`scm`, `problems`, `keybindings`) collapse into the
 *  Files route as sub-tabs. */
export function routeForActivity(activity: Activity): RouteId {
  switch (activity) {
    case "containers":
      return "chats";
    case "diff-events":
      return "library";
    case "files":
    case "scm":
    case "problems":
    case "keybindings":
      return "files";
    case "settings":
      return "settings";
    case "gitops":
    case "search":
    default:
      return "chats";
  }
}

export function shortcutForRoute(id: RouteId): string {
  return ROUTES.find((r) => r.id === id)!.shortcut;
}
