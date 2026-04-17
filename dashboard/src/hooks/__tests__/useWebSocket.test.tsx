/** useWebSocket tests (M11).
 *
 * The heavy lifting — actual dispatch through the singleton — is
 * exercised implicitly by the rest of the test suite and by the
 * Playwright specs. Here we only verify the decoupled error-event
 * contract: ``onWebSocketListenerError`` subscribes to the custom
 * event that the dispatch path fires when a listener throws. That
 * event is the hook's only coupling to the React toast layer, so
 * locking its shape down is the piece worth testing in isolation.
 */

import { afterEach, describe, expect, it } from "vitest";

import { onWebSocketListenerError } from "../useWebSocket";

describe("onWebSocketListenerError", () => {
  const offs: Array<() => void> = [];
  afterEach(() => {
    for (const off of offs) off();
    offs.length = 0;
  });

  it("fires when the hive:ws:listenerError event is dispatched", () => {
    const received: Array<{ channel: string; error: unknown }> = [];
    offs.push(onWebSocketListenerError((detail) => received.push(detail)));

    window.dispatchEvent(
      new CustomEvent("hive:ws:listenerError", {
        detail: { channel: "cmd:42", error: new Error("boom") },
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe("cmd:42");
    expect(received[0].error).toBeInstanceOf(Error);
  });

  it("the unsubscribe function stops further deliveries", () => {
    const received: Array<unknown> = [];
    const off = onWebSocketListenerError((detail) => received.push(detail));
    off();

    window.dispatchEvent(
      new CustomEvent("hive:ws:listenerError", {
        detail: { channel: "x", error: "nope" },
      }),
    );

    expect(received).toHaveLength(0);
  });
});
