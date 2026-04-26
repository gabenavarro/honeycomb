import { act, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchInput } from "../SearchInput";

describe("SearchInput", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the input with placeholder", () => {
    render(<SearchInput value="" onChange={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: /search artifacts/i })).toBeTruthy();
  });

  it("does NOT fire onChange before 250ms have elapsed", () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: /search artifacts/i });

    fireEvent.change(input, { target: { value: "hello" } });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("fires onChange after 250ms of idle with the typed value", () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: /search artifacts/i });

    fireEvent.change(input, { target: { value: "hello" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onChange).toHaveBeenCalledWith("hello");
  });

  it("debounces: only fires once when multiple keystrokes arrive within 250ms", () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: /search artifacts/i });

    fireEvent.change(input, { target: { value: "a" } });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.change(input, { target: { value: "ab" } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    // onChange is called at most once (for "ab") — not once per keystroke
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("ab");
  });
});
