/** CodeMirror 6 wrapper with language detection + dark theme (M24).
 *
 * Bridges CodeMirror's imperative ``EditorView`` to React's
 * declarative ``value`` / ``onChange`` model:
 *
 * - Initial mount creates an EditorView inside a div ref. The
 *   ``updateListener`` fires the parent's ``onChange`` when the doc
 *   changes AND the change didn't originate from our own external-
 *   value sync (guarded by a ref that holds the last-dispatched
 *   string).
 * - Prop ``value`` changes that DIFFER from the editor's current doc
 *   trigger a single transaction replacing the whole doc — the
 *   parent "reset draft" path when the user reloads from the conflict
 *   banner.
 * - ``readOnly`` toggles an editor config compartment so we don't
 *   need to recreate the view.
 * - On unmount we ``editor.destroy()``.
 *
 * Extensions: basicSetup (line numbers + history + fold + bracket
 * matching), the one-dark theme, and the language extension picked
 * by ``languageForPath()`` at the call site.
 */

import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

export type CodeEditorLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "json"
  | "markdown"
  | "css"
  | "html"
  | "plaintext";

export interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  language: CodeEditorLanguage;
  readOnly?: boolean;
  className?: string;
}

const LANG_BY_EXT: Record<string, CodeEditorLanguage> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
};

export function languageForPath(path: string): CodeEditorLanguage {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

function languageExtension(lang: CodeEditorLanguage): Extension {
  switch (lang) {
    case "javascript":
      return javascript();
    case "typescript":
      return javascript({ typescript: true });
    case "python":
      return python();
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "css":
      return css();
    case "html":
      return html();
    default:
      return [];
  }
}

function basicSetup(): Extension {
  // Hand-rolled ``basicSetup`` equivalent so we control the exact
  // extension set (the upstream ``basicSetup`` import pulls more
  // than we need and bloats the bundle).
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...lintKeymap]),
  ];
}

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  className,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompRef = useRef(new Compartment());
  const langCompRef = useRef(new Compartment());
  const lastDispatchedRef = useRef(value);

  // Mount once on first render. We intentionally do NOT include
  // ``value`` in the deps — prop changes are synced via the second
  // effect below.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup(),
        langCompRef.current.of(languageExtension(language)),
        readOnlyCompRef.current.of(EditorState.readOnly.of(readOnly)),
        oneDark,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          if (next === lastDispatchedRef.current) return;
          lastDispatchedRef.current = next;
          onChange(next);
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value → editor when the parent resets the draft
  // (e.g. the "Reload" button on the conflict banner).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    lastDispatchedRef.current = value;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  // Toggle language / readOnly without recreating the view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: langCompRef.current.reconfigure(languageExtension(language)),
    });
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  return <div ref={hostRef} className={className ?? "h-full w-full"} />;
}
