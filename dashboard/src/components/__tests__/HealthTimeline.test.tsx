/** HealthTimeline tests (M25).
 *
 * Mocks useResourceHistory and ResourceMonitor so the component's
 * rendering logic is exercised without network / docker.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HealthTimeline } from "../HealthTimeline";

const mockHook = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useResourceHistory", () => ({
  useResourceHistory: mockHook,
}));

vi.mock("../ResourceMonitor", () => ({
  ResourceMonitor: ({ containerId }: { containerId: number | null }) => (
    <div data-testid="resource-monitor-stub">rm:{containerId}</div>
  ),
}));

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function sample(
  cpu = 10,
  mem = 20,
  gpu: number | null = 30,
  ts = "2026-04-19T00:00:00",
) {
  return {
    container_id: "c1",
    cpu_percent: cpu,
    memory_mb: 100,
    memory_limit_mb: 1000,
    memory_percent: mem,
    gpu_utilization: gpu,
    gpu_memory_mb: gpu === null ? null : 500,
    gpu_memory_total_mb: gpu === null ? null : 2000,
    timestamp: ts,
  };
}

beforeEach(() => {
  mockHook.mockReset();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: false } },
  });
});
afterEach(() => {
  qc.clear();
  vi.restoreAllMocks();
});

describe("HealthTimeline", () => {
  it("renders the Collecting placeholder when buffer is empty", () => {
    mockHook.mockReturnValue([]);
    render(<HealthTimeline containerId={1} />, { wrapper });
    expect(screen.getByText(/collecting/i)).toBeInTheDocument();
  });

  it("renders CPU, MEM, and GPU labels when samples are present", () => {
    mockHook.mockReturnValue([sample(10, 20, 30, "t1"), sample(12, 22, 32, "t2")]);
    render(<HealthTimeline containerId={1} />, { wrapper });
    expect(screen.getByText(/CPU/i)).toBeInTheDocument();
    expect(screen.getByText(/MEM/i)).toBeInTheDocument();
    expect(screen.getByText(/GPU/i)).toBeInTheDocument();
  });

  it("shows the last value as text next to each sparkline", () => {
    mockHook.mockReturnValue([sample(42, 55, 77, "t1")]);
    render(<HealthTimeline containerId={1} />, { wrapper });
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText("55%")).toBeInTheDocument();
    expect(screen.getByText("77%")).toBeInTheDocument();
  });

  it("marks the GPU sparkline dim when every sample has null gpu_utilization", () => {
    mockHook.mockReturnValue([sample(10, 20, null, "t1"), sample(12, 22, null, "t2")]);
    const { container } = render(<HealthTimeline containerId={1} />, { wrapper });
    const gpu = container.querySelector('[data-slot="gpu-sparkline"]');
    expect(gpu).not.toBeNull();
    expect(gpu?.className).toMatch(/opacity-40/);
  });

  it("clicking the strip opens a popover with ResourceMonitor", async () => {
    mockHook.mockReturnValue([sample(10, 20, 30, "t1")]);
    render(<HealthTimeline containerId={1} />, { wrapper });
    await userEvent.click(screen.getByRole("button", { name: /open resource monitor/i }));
    expect(await screen.findByTestId("resource-monitor-stub")).toBeInTheDocument();
  });
});
