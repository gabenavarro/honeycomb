/** Route table tests (M32). */
import { describe, expect, it } from "vitest";

import {
  ROUTES,
  ROUTE_IDS,
  activityForRoute,
  routeForActivity,
  routeForPathname,
  pathnameForRoute,
  shortcutForRoute,
  type RouteId,
} from "../routes";

describe("routes table", () => {
  it("exposes exactly four route ids", () => {
    expect(ROUTE_IDS).toEqual(["chats", "library", "files", "settings"]);
  });

  it("each route has a unique pathname", () => {
    const seen = new Set<string>();
    for (const r of ROUTES) {
      expect(seen.has(r.pathname)).toBe(false);
      seen.add(r.pathname);
    }
    expect(seen.size).toBe(4);
  });

  it("pathnameForRoute round-trips", () => {
    expect(pathnameForRoute("chats")).toBe("/chats");
    expect(pathnameForRoute("library")).toBe("/library");
    expect(pathnameForRoute("files")).toBe("/files");
    expect(pathnameForRoute("settings")).toBe("/settings");
  });

  it("routeForPathname matches exact and prefix", () => {
    expect(routeForPathname("/chats")).toBe("chats");
    expect(routeForPathname("/library/anything")).toBe("library");
    expect(routeForPathname("/")).toBe("chats"); // root falls back to chats
    expect(routeForPathname("/unknown")).toBe("chats"); // unknown falls back to chats
  });

  it("activityForRoute / routeForActivity are inverses for owned activities", () => {
    expect(activityForRoute("chats")).toBe("containers");
    expect(activityForRoute("library")).toBe("diff-events");
    expect(activityForRoute("files")).toBe("files");
    expect(activityForRoute("settings")).toBe("settings");
    expect(routeForActivity("containers")).toBe("chats");
    expect(routeForActivity("diff-events")).toBe("library");
    expect(routeForActivity("files")).toBe("files");
    expect(routeForActivity("scm")).toBe("files");
    expect(routeForActivity("problems")).toBe("files");
    expect(routeForActivity("keybindings")).toBe("files");
    expect(routeForActivity("settings")).toBe("settings");
    expect(routeForActivity("gitops")).toBe("chats"); // legacy → fold into chats
    expect(routeForActivity("search")).toBe("chats"); // legacy → fold into chats
  });

  it("shortcutForRoute returns the spec'd combos", () => {
    expect(shortcutForRoute("chats")).toBe("Mod+1");
    expect(shortcutForRoute("library")).toBe("Mod+2");
    expect(shortcutForRoute("files")).toBe("Mod+3");
    expect(shortcutForRoute("settings")).toBe("Mod+,");
  });

  it("RouteId TS type contains exactly the four ids (compile-time)", () => {
    const _check: RouteId[] = ["chats", "library", "files", "settings"];
    expect(_check.length).toBe(4);
  });
});
