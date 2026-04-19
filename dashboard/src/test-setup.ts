import "@testing-library/jest-dom/vitest";

// cmdk uses ResizeObserver internally. jsdom does not provide it.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
