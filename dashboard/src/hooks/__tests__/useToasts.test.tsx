/** ToastProvider tests (M8).
 *
 * After migrating to Radix Toast the DOM lifecycle is async — a dismiss
 * flips ``open=false`` and the close transition runs before the node is
 * reaped. We assert on Radix's ``data-state`` attribute rather than
 * using fake timers, which were fragile against the primitive's internal
 * timing.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToastProvider, useToasts } from "../useToasts";

function TestHarness({ onReady }: { onReady: (ctx: ReturnType<typeof useToasts>) => void }) {
  const ctx = useToasts();
  onReady(ctx);
  return null;
}

describe("ToastProvider", () => {
  it("renders a toast with title and body", () => {
    let api: ReturnType<typeof useToasts> | null = null;
    render(
      <ToastProvider>
        <TestHarness onReady={(ctx) => (api = ctx)} />
      </ToastProvider>,
    );

    act(() => {
      api!.toast("info", "Hello", "World", 60_000);
    });
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("World")).toBeInTheDocument();
  });

  it("gives error toasts role=alert for screen readers", () => {
    let api: ReturnType<typeof useToasts> | null = null;
    render(
      <ToastProvider>
        <TestHarness onReady={(ctx) => (api = ctx)} />
      </ToastProvider>,
    );
    act(() => {
      api!.toast("error", "Failure", undefined, 60_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Failure");
  });

  it("appends toast to history and increments unreadCount", () => {
    let api: ReturnType<typeof useToasts> | null = null;
    render(
      <ToastProvider>
        <TestHarness onReady={(ctx) => (api = ctx)} />
      </ToastProvider>,
    );
    act(() => {
      api!.toast("info", "first", undefined, 60_000);
      api!.toast("warning", "second");
    });
    expect(api!.history).toHaveLength(2);
    expect(api!.history[0].title).toBe("first");
    expect(api!.history[1].title).toBe("second");
    expect(api!.unreadCount).toBe(2);
  });

  it("caps history at 50 entries (ring-buffer drops oldest)", () => {
    let api: ReturnType<typeof useToasts> | null = null;
    render(
      <ToastProvider>
        <TestHarness onReady={(ctx) => (api = ctx)} />
      </ToastProvider>,
    );
    act(() => {
      for (let i = 0; i < 55; i++) api!.toast("info", `t${i}`, undefined, 60_000);
    });
    expect(api!.history).toHaveLength(50);
    // Oldest 5 were dropped; first surviving entry should be t5.
    expect(api!.history[0].title).toBe("t5");
    expect(api!.history[49].title).toBe("t54");
  });

  it("markHistoryRead clears unreadCount but leaves history intact", () => {
    let api: ReturnType<typeof useToasts> | null = null;
    render(
      <ToastProvider>
        <TestHarness onReady={(ctx) => (api = ctx)} />
      </ToastProvider>,
    );
    act(() => {
      api!.toast("info", "a");
      api!.toast("info", "b");
    });
    expect(api!.unreadCount).toBe(2);
    act(() => api!.markHistoryRead());
    expect(api!.unreadCount).toBe(0);
    expect(api!.history).toHaveLength(2);
  });

  it("clearHistory empties history and resets unreadCount", () => {
    let api: ReturnType<typeof useToasts> | null = null;
    render(
      <ToastProvider>
        <TestHarness onReady={(ctx) => (api = ctx)} />
      </ToastProvider>,
    );
    act(() => {
      api!.toast("error", "boom");
    });
    act(() => api!.clearHistory());
    expect(api!.history).toHaveLength(0);
    expect(api!.unreadCount).toBe(0);
  });

  it("applies default duration by kind when no override is given", () => {
    let api: ReturnType<typeof useToasts> | null = null;
    render(
      <ToastProvider>
        <TestHarness onReady={(ctx) => (api = ctx)} />
      </ToastProvider>,
    );
    act(() => {
      api!.toast("info", "i");
      api!.toast("warning", "w");
      api!.toast("error", "e");
    });
    const [info, warn, err] = api!.history;
    expect(info.durationMs).toBe(3000);
    expect(warn.durationMs).toBe(5000);
    expect(err.durationMs).toBe(8000);
  });

  it("dismiss flips the toast to data-state=closed", async () => {
    let api: ReturnType<typeof useToasts> | null = null;
    render(
      <ToastProvider>
        <TestHarness onReady={(ctx) => (api = ctx)} />
      </ToastProvider>,
    );

    let id = 0;
    act(() => {
      id = api!.toast("info", "Heads up", undefined, 60_000);
    });
    const node = screen.getByText("Heads up").closest("[data-state]") as HTMLElement;
    expect(node).not.toBeNull();
    expect(node.getAttribute("data-state")).toBe("open");

    act(() => {
      api!.dismiss(id);
    });
    await waitFor(() => expect(node.getAttribute("data-state")).toBe("closed"), { timeout: 2000 });
  });
});
