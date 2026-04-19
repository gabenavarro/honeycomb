/** CodeEditor tests (M24) — mount, controlled value, onChange, readOnly.
 *
 * jsdom lacks layout APIs CodeMirror touches; we stub the ones we
 * need in test-setup.ts (``document.createRange`` and
 * ``Element.prototype.getClientRects``). Without those stubs the
 * ``EditorView`` throws on mount.
 */

import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeEditor, languageForPath } from "../CodeEditor";

afterEach(() => vi.restoreAllMocks());

describe("languageForPath", () => {
  it.each([
    ["src/App.tsx", "typescript"],
    ["foo.py", "python"],
    ["package.json", "json"],
    ["README.md", "markdown"],
    ["style.css", "css"],
    ["index.html", "html"],
    ["no-ext", "plaintext"],
    ["WEIRD.CaSe.PY", "python"],
  ])("%s → %s", (path, lang) => {
    expect(languageForPath(path)).toBe(lang);
  });
});

describe("CodeEditor", () => {
  it("mounts with the initial value", () => {
    const { container } = render(
      <CodeEditor value="hello world" onChange={() => {}} language="plaintext" />,
    );
    // CodeMirror renders a ``.cm-editor`` wrapper + a ``.cm-content`` that
    // contains the document text.
    const content = container.querySelector(".cm-content");
    expect(content?.textContent).toContain("hello world");
  });

  it("fires onChange when the user types", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <CodeEditor value="" onChange={onChange} language="plaintext" />,
    );
    const content = container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    content!.focus();
    await userEvent.type(content!, "abc");
    // CodeMirror batches transactions; by the end of ``type`` we
    // should have seen at least one call whose argument contains
    // the typed characters.
    expect(onChange).toHaveBeenCalled();
    const allArgs = onChange.mock.calls.map((c) => c[0]).join("");
    expect(allArgs).toContain("abc");
  });

  it("readOnly prevents edits", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <CodeEditor value="locked" onChange={onChange} language="plaintext" readOnly />,
    );
    const content = container.querySelector<HTMLElement>(".cm-content");
    content!.focus();
    await userEvent.type(content!, "xxx");
    expect(onChange).not.toHaveBeenCalled();
  });
});
