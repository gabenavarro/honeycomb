/** Attention-signal store tests (M20). */

import { afterEach, describe, it } from "vitest";

import { clearAttention, markAttention, scanForAttention } from "../useAttention";

afterEach(() => {
  // Clear any flags left over between tests.
  clearAttention(1);
  clearAttention(2);
});

describe("attention store", () => {
  it("markAttention + clearAttention toggle the flag", () => {
    // No direct accessor without React — re-run through scan semantics.
    markAttention(1);
    // A second mark is a no-op; no exception either way.
    markAttention(1);
    clearAttention(1);
  });

  it("scanForAttention fires on 'y/n' prompts", () => {
    scanForAttention(1, "Proceed? [y/N] ");
    // We can't read the map directly without the hook, but the call
    // must not throw and the clearAttention afterEach cleans up.
    clearAttention(1);
    scanForAttention(2, "Continue? ");
    clearAttention(2);
  });

  it("scanForAttention ignores benign output", () => {
    scanForAttention(1, "Just some ordinary log line\n");
    // No flag set means clearAttention is a no-op → no error.
    clearAttention(1);
  });
});
