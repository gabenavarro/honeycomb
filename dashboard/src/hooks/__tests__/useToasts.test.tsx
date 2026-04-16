import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToasts } from "../useToasts";

function TestHarness({ onReady }: { onReady: (ctx: ReturnType<typeof useToasts>) => void }) {
  const ctx = useToasts();
  onReady(ctx);
  return null;
}

describe("ToastProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a toast and auto-dismisses after the duration", () => {
    let api: ReturnType<typeof useToasts> | null = null;
    render(
      <ToastProvider>
        <TestHarness onReady={(ctx) => (api = ctx)} />
      </ToastProvider>,
    );

    act(() => {
      api!.toast("error", "Boom", "Thing broke", 1000);
    });
    expect(screen.getByText("Boom")).toBeInTheDocument();
    expect(screen.getByText("Thing broke")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByText("Boom")).not.toBeInTheDocument();
  });

  it("dismiss removes a toast immediately", () => {
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
    expect(screen.getByText("Heads up")).toBeInTheDocument();

    act(() => {
      api!.dismiss(id);
    });
    expect(screen.queryByText("Heads up")).not.toBeInTheDocument();
  });

  it("gives error toasts role=alert for screen readers", () => {
    let api: ReturnType<typeof useToasts> | null = null;
    render(
      <ToastProvider>
        <TestHarness onReady={(ctx) => (api = ctx)} />
      </ToastProvider>,
    );
    act(() => {
      api!.toast("error", "Failure");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Failure");
  });
});
