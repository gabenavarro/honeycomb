/** ModeToggle tests (M33). */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ModeToggle } from "../ModeToggle";

beforeEach(() => {
  window.localStorage.clear();
});

describe("ModeToggle", () => {
  it("defaults to 'code' when no stored value", () => {
    render(<ModeToggle sessionId="s1" />);
    expect(screen.getByRole("radio", { name: "Code" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Review" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByRole("radio", { name: "Plan" }).getAttribute("aria-checked")).toBe("false");
  });

  it("loads stored mode on mount", () => {
    window.localStorage.setItem("hive:chat:s2:mode", "review");
    render(<ModeToggle sessionId="s2" />);
    expect(screen.getByRole("radio", { name: "Review" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Code" }).getAttribute("aria-checked")).toBe("false");
  });

  it("clicking a mode persists + flips aria-checked", () => {
    render(<ModeToggle sessionId="s3" />);
    fireEvent.click(screen.getByRole("radio", { name: "Plan" }));
    expect(screen.getByRole("radio", { name: "Plan" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Code" }).getAttribute("aria-checked")).toBe("false");
    expect(window.localStorage.getItem("hive:chat:s3:mode")).toBe("plan");
  });
});
