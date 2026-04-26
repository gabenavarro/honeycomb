import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AttachmentChip } from "../AttachmentChip";

describe("AttachmentChip", () => {
  it("renders the path", () => {
    render(<AttachmentChip path="src/main.tsx" onRemove={vi.fn()} />);
    expect(screen.getByText("src/main.tsx")).toBeTruthy();
  });

  it("clicking × calls onRemove", () => {
    const onRemove = vi.fn();
    render(<AttachmentChip path="foo.py" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove foo.py/i }));
    expect(onRemove).toHaveBeenCalled();
  });

  it("long paths truncate via CSS but full path is in title", () => {
    const long = "a/very/deeply/nested/path/to/some/file.tsx";
    render(<AttachmentChip path={long} onRemove={vi.fn()} />);
    const el = screen.getByText(long);
    expect(el.getAttribute("title")).toBe(long);
  });
});
