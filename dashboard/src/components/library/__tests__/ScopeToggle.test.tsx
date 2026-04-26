import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ScopeToggle } from "../ScopeToggle";

describe("ScopeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to 'active' scope when no localStorage value exists", () => {
    render(<ScopeToggle activeContainerName="my-project" onScopeChange={vi.fn()} />);
    const activeBtn = screen.getByRole("button", { name: /my-project/i });
    expect(activeBtn.getAttribute("aria-pressed")).toBe("true");
    const fleetBtn = screen.getByRole("button", { name: /fleet/i });
    expect(fleetBtn.getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking Fleet button flips scope to 'fleet'", () => {
    const onScopeChange = vi.fn();
    render(<ScopeToggle activeContainerName="my-project" onScopeChange={onScopeChange} />);
    const fleetBtn = screen.getByRole("button", { name: /fleet/i });
    fireEvent.click(fleetBtn);
    expect(fleetBtn.getAttribute("aria-pressed")).toBe("true");
    expect(onScopeChange).toHaveBeenCalledWith("fleet");
  });

  it("persists scope to localStorage on toggle", () => {
    render(<ScopeToggle activeContainerName="my-project" onScopeChange={vi.fn()} />);
    const fleetBtn = screen.getByRole("button", { name: /fleet/i });
    fireEvent.click(fleetBtn);
    // useLocalStorage stores JSON-serialised values (JSON.stringify("fleet") === '"fleet"')
    expect(window.localStorage.getItem("hive:library:scope")).toBe('"fleet"');
  });

  it("reads persisted scope from localStorage on mount", () => {
    // useLocalStorage reads via JSON.parse, so the stored value must be JSON-encoded
    window.localStorage.setItem("hive:library:scope", '"fleet"');
    render(<ScopeToggle activeContainerName="my-project" onScopeChange={vi.fn()} />);
    const fleetBtn = screen.getByRole("button", { name: /fleet/i });
    expect(fleetBtn.getAttribute("aria-pressed")).toBe("true");
  });
});
