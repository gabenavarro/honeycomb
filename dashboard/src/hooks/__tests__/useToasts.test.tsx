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
