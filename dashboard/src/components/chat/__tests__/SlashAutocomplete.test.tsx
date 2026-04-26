import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SlashAutocomplete } from "../SlashAutocomplete";

describe("SlashAutocomplete", () => {
  it("renders nothing when input prefix is non-slash", () => {
    const { container } = render(<SlashAutocomplete prefix="hello" onSelect={vi.fn()} />);
    expect(container.querySelector("[role='listbox']")).toBeNull();
  });

  it("renders all 8 commands for a bare '/' prefix", () => {
    render(<SlashAutocomplete prefix="/" onSelect={vi.fn()} />);
    const opts = screen.getAllByRole("option");
    expect(opts).toHaveLength(8);
  });

  it("filters to /save and /skill on prefix '/s'", () => {
    render(<SlashAutocomplete prefix="/s" onSelect={vi.fn()} />);
    const opts = screen.getAllByRole("option").map((o) => o.textContent);
    expect(opts.some((t) => t?.startsWith("/save"))).toBe(true);
    expect(opts.some((t) => t?.startsWith("/skill"))).toBe(true);
    // /edit etc not shown
    expect(opts.some((t) => t?.startsWith("/edit"))).toBe(false);
  });

  it("clicking an option calls onSelect with that command name + trailing space", () => {
    const onSelect = vi.fn();
    render(<SlashAutocomplete prefix="/" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("/edit", { exact: false }));
    expect(onSelect).toHaveBeenCalledWith("/edit ");
  });

  it("renders empty list when prefix matches no command", () => {
    const { container } = render(<SlashAutocomplete prefix="/xyz" onSelect={vi.fn()} />);
    expect(container.querySelectorAll("[role='option']")).toHaveLength(0);
  });
});
