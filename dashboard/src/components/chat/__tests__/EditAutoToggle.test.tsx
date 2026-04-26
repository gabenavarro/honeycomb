import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EditAutoToggle } from "../EditAutoToggle";

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("EditAutoToggle", () => {
  it("defaults to off when no stored value", () => {
    render(<EditAutoToggle sessionId="s1" />);
    expect((screen.getByRole("switch") as HTMLInputElement).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("loads stored value on mount", () => {
    window.localStorage.setItem("hive:chat:s2:edit-auto", "true");
    render(<EditAutoToggle sessionId="s2" />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("clicking toggles + persists", () => {
    render(<EditAutoToggle sessionId="s3" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(window.localStorage.getItem("hive:chat:s3:edit-auto")).toBe("true");
  });
});
