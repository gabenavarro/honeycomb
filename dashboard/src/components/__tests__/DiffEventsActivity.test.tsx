import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { DiffEventsActivity } from "../DiffEventsActivity";
import type { DiffEvent } from "../../lib/types";

const mockUseDiffEvents = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/useDiffEvents", () => ({
  useDiffEvents: mockUseDiffEvents,
}));

const todayIso = new Date().toISOString();
const yesterday = new Date(Date.now() - 86_400_000).toISOString();

function ev(id: string, path: string, ts: string, tool: DiffEvent["tool"] = "Edit"): DiffEvent {
  return {
    event_id: id,
    container_id: 1,
    claude_session_id: null,
    tool_use_id: "t" + id,
    tool,
    path,
    diff: "--- a\n+++ b\n",
    added_lines: 14,
    removed_lines: 8,
    size_bytes: 30,
    timestamp: ts,
    created_at: ts,
  };
}

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockUseDiffEvents.mockReset();
});

describe("DiffEventsActivity", () => {
  it("renders date-grouped events", () => {
    mockUseDiffEvents.mockReturnValue({
      events: [
        ev("e1", "/a/today.ts", todayIso),
        ev("e2", "/a/y.ts", yesterday),
      ],
      isLoading: false,
      error: null,
    });
    render(<DiffEventsActivity containerId={1} onOpenEvent={() => {}} />, { wrapper });
    expect(screen.getAllByText(/today/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/yesterday/i)).toBeTruthy();
  });

  it("filters rows by path with the search input", () => {
    mockUseDiffEvents.mockReturnValue({
      events: [
        ev("e1", "/dashboard/App.tsx", todayIso),
        ev("e2", "/hub/main.py", todayIso),
      ],
      isLoading: false,
      error: null,
    });
    render(<DiffEventsActivity containerId={1} onOpenEvent={() => {}} />, { wrapper });
    const input = screen.getByPlaceholderText(/filter by path/i);
    fireEvent.change(input, { target: { value: "main" } });
    expect(screen.queryByText(/App\.tsx/)).toBeNull();
    expect(screen.getByText(/main\.py/)).toBeTruthy();
  });

  it("calls onOpenEvent when a row is clicked", () => {
    const onOpenEvent = vi.fn();
    const e = ev("e1", "/a/x.ts", todayIso);
    mockUseDiffEvents.mockReturnValue({ events: [e], isLoading: false, error: null });
    render(<DiffEventsActivity containerId={1} onOpenEvent={onOpenEvent} />, { wrapper });
    fireEvent.click(screen.getByText("x.ts").closest("[data-row]")!);
    expect(onOpenEvent).toHaveBeenCalledWith(e);
  });

  it("shows a tool color gutter on each row (data-tool attr)", () => {
    mockUseDiffEvents.mockReturnValue({
      events: [
        ev("e1", "/a", todayIso, "Edit"),
        ev("e2", "/b", todayIso, "Write"),
        ev("e3", "/c", todayIso, "MultiEdit"),
      ],
      isLoading: false,
      error: null,
    });
    render(<DiffEventsActivity containerId={1} onOpenEvent={() => {}} />, { wrapper });
    const rows = document.querySelectorAll("[data-row]");
    expect(rows[0].getAttribute("data-tool")).toBe("Edit");
    expect(rows[1].getAttribute("data-tool")).toBe("Write");
    expect(rows[2].getAttribute("data-tool")).toBe("MultiEdit");
  });
});
