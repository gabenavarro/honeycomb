import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EffortPickerSheet } from "../EffortPickerSheet";

describe("EffortPickerSheet", () => {
  it("renders Quick / Standard / Deep / Max when open", () => {
    render(
      <EffortPickerSheet open={true} effort="standard" onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /^quick$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^standard$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^deep$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^max$/i })).toBeTruthy();
  });

  it("clicking an effort calls onSelect and onClose", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <EffortPickerSheet open={true} effort="standard" onSelect={onSelect} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^deep$/i }));
    expect(onSelect).toHaveBeenCalledWith("deep");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
