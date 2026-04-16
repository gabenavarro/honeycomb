import { describe, expect, it } from "vitest";
import { backoffRefetch } from "../useSmartPoll";

function fakeQuery(failCount: number) {
  // Only the fields backoffRefetch reads are needed.
  return { state: { fetchFailureCount: failCount } } as Parameters<
    ReturnType<typeof backoffRefetch>
  >[0];
}

describe("backoffRefetch", () => {
  it("returns baseMs when there are no failures", () => {
    const fn = backoffRefetch({ baseMs: 5000, maxMs: 60_000 });
    expect(fn(fakeQuery(0))).toBe(5000);
  });

  it("doubles the interval per consecutive failure", () => {
    const fn = backoffRefetch({ baseMs: 1000, maxMs: 60_000, multiplier: 2 });
    expect(fn(fakeQuery(1))).toBe(2000);
    expect(fn(fakeQuery(2))).toBe(4000);
    expect(fn(fakeQuery(3))).toBe(8000);
  });

  it("clamps at maxMs", () => {
    const fn = backoffRefetch({ baseMs: 1000, maxMs: 5000, multiplier: 2 });
    // 1000 * 2^10 would be huge; must cap at maxMs.
    expect(fn(fakeQuery(10))).toBe(5000);
  });

  it("respects custom multiplier", () => {
    const fn = backoffRefetch({ baseMs: 1000, maxMs: 60_000, multiplier: 3 });
    expect(fn(fakeQuery(1))).toBe(3000);
    expect(fn(fakeQuery(2))).toBe(9000);
  });
});
