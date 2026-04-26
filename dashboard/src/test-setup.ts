import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// WorkspacePicker renders project names in spans marked [data-project-name].
// When workspace_folder contains the project_name as a substring (e.g.
// project_name="foo", workspace_folder="/repos/foo"), getByText(/foo/) would
// match BOTH the name span and the path span. Excluding [data-project-name]
// from the default text-query ignore list ensures getByText finds only the
// workspace path span — the unique per-row identifier.
configure({
  defaultIgnore: "script, style, [data-project-name]",
});

// cmdk uses ResizeObserver internally. jsdom does not provide it.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// M36 — jsdom does not implement matchMedia. The M36 useMediaQuery hook
// (src/hooks/useMediaQuery.ts) defaults useIsPhone() to true when
// matchMedia is missing, which would flip every existing test rendering
// a useIsPhone-aware component to the phone branch. Stub matchMedia to
// default to DESKTOP behavior (matches=true for any min-width query)
// so existing M0–M35 tests continue to render their desktop layout.
//
// Tests that need to override (e.g. test the phone branch explicitly)
// can still install their own per-test matchMedia mock — vi.stubGlobal
// or Object.defineProperty (the useMediaQuery hook test in T2 uses the
// latter pattern and that pattern is unaffected by this default).
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      // Default to desktop: any min-width query matches.
      matches: query.includes("min-width"),
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
      onchange: null,
    }),
  });
}

// cmdk calls scrollIntoView on list items. jsdom stubs it as undefined.
if (typeof Element.prototype.scrollIntoView === "undefined") {
  Element.prototype.scrollIntoView = () => {};
}

// M24 — CodeMirror calls ``document.createRange`` and measures
// ranges with ``getClientRects``. jsdom provides ``createRange`` but
// the returned Range object has no ``getClientRects``, which causes
// ``EditorView``'s measure loop to throw. Patch Range.prototype
// unconditionally (jsdom returns empty DOMRectList objects that still
// lack the ``getClientRects`` method on individual Range instances).
// Keep the stubs minimal — tests assert on DOM text / click events,
// not on pixel coordinates.
const emptyRectList = (): DOMRectList =>
  ({
    item: () => null,
    length: 0,
    [Symbol.iterator]: function* () {},
  }) as unknown as DOMRectList;

// Patch Range.prototype so every range created by document.createRange
// returns a safe empty rect list.
if (typeof Range !== "undefined") {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = emptyRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
  }
}

if (typeof Element.prototype.getClientRects === "undefined") {
  Element.prototype.getClientRects = emptyRectList;
}
