import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// react-diff-view ships a CSS bundle that Vitest/jsdom can't process.
// Stub it so the import doesn't crash the test environment.
vi.mock("react-diff-view/style/index.css", () => ({}));

import { DiffViewerTab } from "../DiffViewerTab";
import type { DiffEvent } from "../../lib/types";

const sample: DiffEvent = {
  event_id: "e1",
  container_id: 1,
  claude_session_id: null,
  tool_use_id: "t1",
  tool: "Edit",
  path: "/workspace/foo.ts",
  diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-const x = 1;\n+const x = 2;\n",
  added_lines: 1,
  removed_lines: 1,
  size_bytes: 80,
  timestamp: "2026-04-23T07:38:00Z",
  created_at: "2026-04-23T07:38:00Z",
};

describe("DiffViewerTab", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
  });

  it("renders the path and stat in the header", () => {
    render(<DiffViewerTab event={sample} onOpenFile={() => {}} />);
    expect(screen.getByText(/foo\.ts/)).toBeTruthy();
    expect(screen.getByText(/\+1/)).toBeTruthy();
  });

  it("toggles between Unified and Split modes", () => {
    render(<DiffViewerTab event={sample} onOpenFile={() => {}} />);
    const split = screen.getByRole("button", { name: /split/i });
    fireEvent.click(split);
    expect(split.getAttribute("data-on")).toBe("true");
    const unified = screen.getByRole("button", { name: /unified/i });
    fireEvent.click(unified);
    expect(unified.getAttribute("data-on")).toBe("true");
  });

  it("calls onOpenFile when Open file is clicked", () => {
    const onOpenFile = vi.fn();
    render(<DiffViewerTab event={sample} onOpenFile={onOpenFile} />);
    fireEvent.click(screen.getByRole("button", { name: /open file/i }));
    expect(onOpenFile).toHaveBeenCalledWith("/workspace/foo.ts");
  });

  it("copies diff text on Copy patch", () => {
    render(<DiffViewerTab event={sample} onOpenFile={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /copy patch/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(sample.diff);
  });

  it("persists the view-mode preference to localStorage", () => {
    localStorage.removeItem("hive:diff-view-mode");
    render(<DiffViewerTab event={sample} onOpenFile={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /split/i }));
    expect(localStorage.getItem("hive:diff-view-mode")).toBe("split");
  });
});
