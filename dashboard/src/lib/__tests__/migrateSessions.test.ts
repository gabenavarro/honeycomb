/** M26 — client-side migration of legacy localStorage session state.
 *
 * Exercises the pure data-shuffling logic: the migration POSTs each
 * session, builds oldId→newId map, rewrites dependent keys, wipes
 * pty-label sessionStorage, clears the source key, and sets the
 * idempotency guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSessionMigration } from "../migrateSessions";

const mockCreate = vi.hoisted(() =>
  vi.fn<(id: number, body: unknown) => Promise<unknown>>(),
);

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, createNamedSession: mockCreate };
});

beforeEach(() => {
  mockCreate.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function serverRow(sid: string, name = "Main", kind = "shell") {
  return {
    session_id: sid,
    container_id: 1,
    name,
    kind,
    created_at: "2026-04-20T00:00:00",
    updated_at: "2026-04-20T00:00:00",
  };
}

describe("runSessionMigration", () => {
  it("is a no-op when the guard key is already set", async () => {
    localStorage.setItem("hive:layout:sessionsMigratedAt", "2026-04-20");
    const result = await runSessionMigration();
    expect(result.migrated).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("is a no-op when no legacy sessions exist", async () => {
    const result = await runSessionMigration();
    expect(result.migrated).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(localStorage.getItem("hive:layout:sessionsMigratedAt")).toBeTruthy();
  });

  it("migrates a single-container localStorage snapshot end-to-end", async () => {
    localStorage.setItem(
      "hive:layout:sessions",
      JSON.stringify({
        "7": [
          { id: "default", name: "Main" },
          { id: "s-abc", name: "Build" },
        ],
      }),
    );
    localStorage.setItem(
      "hive:layout:activeSession",
      JSON.stringify({ "7": "s-abc" }),
    );
    localStorage.setItem("hive:terminal-last-kind:7:s-abc", "claude");
    sessionStorage.setItem("hive:pty:label:7:default", "default-abcdef01");
    sessionStorage.setItem("hive:pty:label:7:s-abc", "s-abc-deadbeef");

    mockCreate.mockImplementation(async (_cid, body) => {
      const b = body as { name: string; kind?: string };
      return serverRow(`srv-${b.name.toLowerCase()}`, b.name, b.kind ?? "shell");
    });

    const result = await runSessionMigration();

    expect(result.migrated).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // Kind pulled from hive:terminal-last-kind:*.
    const calledWith = mockCreate.mock.calls.map((c) => c[1]);
    expect(calledWith).toContainEqual({ name: "Main", kind: "shell" });
    expect(calledWith).toContainEqual({ name: "Build", kind: "claude" });

    // activeSession rewritten: s-abc → srv-build.
    const active = JSON.parse(
      localStorage.getItem("hive:layout:activeSession") ?? "{}",
    );
    expect(active).toEqual({ "7": "srv-build" });

    // terminal-last-kind moved to the new id.
    expect(localStorage.getItem("hive:terminal-last-kind:7:s-abc")).toBeNull();
    expect(localStorage.getItem("hive:terminal-last-kind:7:srv-build")).toBe("claude");

    // pty-label sessionStorage wiped.
    expect(sessionStorage.getItem("hive:pty:label:7:default")).toBeNull();
    expect(sessionStorage.getItem("hive:pty:label:7:s-abc")).toBeNull();

    // Source key cleared; guard set.
    expect(localStorage.getItem("hive:layout:sessions")).toBeNull();
    expect(localStorage.getItem("hive:layout:sessionsMigratedAt")).toBeTruthy();
  });

  it("skips entries whose POST 404s and continues with the rest", async () => {
    localStorage.setItem(
      "hive:layout:sessions",
      JSON.stringify({
        "999": [{ id: "ghost", name: "Ghost" }],
        "7": [{ id: "live", name: "Live" }],
      }),
    );

    mockCreate.mockImplementation(async (cid, body) => {
      if (cid === 999) {
        const err = Object.assign(new Error("404: not found"), { status: 404 });
        throw err;
      }
      const b = body as { name: string };
      return serverRow(`srv-${b.name.toLowerCase()}`, b.name);
    });

    const result = await runSessionMigration();

    expect(result.migrated).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].containerId).toBe("999");
    expect(result.skipped[0].oldId).toBe("ghost");
  });
});
