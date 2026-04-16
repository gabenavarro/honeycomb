import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ContainerStatusBadge, AgentStatusBadge, GpuBadge } from "../StatusBadge";

describe("ContainerStatusBadge", () => {
  it("renders running status", () => {
    render(<ContainerStatusBadge status="running" />);
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("renders error status", () => {
    render(<ContainerStatusBadge status="error" />);
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  it("renders stopped status", () => {
    render(<ContainerStatusBadge status="stopped" />);
    expect(screen.getByText("stopped")).toBeInTheDocument();
  });
});

describe("AgentStatusBadge", () => {
  it("renders idle status", () => {
    render(<AgentStatusBadge status="idle" />);
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("renders busy status", () => {
    render(<AgentStatusBadge status="busy" />);
    expect(screen.getByText("busy")).toBeInTheDocument();
  });
});

describe("GpuBadge", () => {
  it("renders GPU label", () => {
    render(<GpuBadge />);
    expect(screen.getByText("GPU")).toBeInTheDocument();
  });
});
