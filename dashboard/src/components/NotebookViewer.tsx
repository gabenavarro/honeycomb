/** Read-only Jupyter notebook (.ipynb) renderer (M19).
 *
 * Parses the ``.ipynb`` JSON client-side and delegates rendering to
 * ``react-ipynb-renderer``. Scope is deliberately read-only: no kernel,
 * no cell execution, no edit mode. Markdown, code, and embedded
 * outputs (text, HTML, PNG, JPEG, SVG, LaTeX via MathJax) all render.
 *
 * Picked ``react-ipynb-renderer`` over ``react-jupyter-notebook``:
 *
 *  - tree-shakeable build, smaller bundle,
 *  - multiple built-in themes (we use ``onedork`` to match the
 *    dashboard's dark palette),
 *  - MathJax-based LaTeX support out of the box,
 *  - still actively published on npm.
 *
 * Rewrite is explicitly NOT warranted — this is a single component add
 * on the existing React 19 / Vite 8 stack. Execution support (kernel
 * gateway, cell-run WebSocket protocol) is a separate effort and
 * documented as out of scope in docs/ARCHITECTURE.md.
 */

import { useMemo } from "react";
import { IpynbRenderer, type Ipynb } from "react-ipynb-renderer";
import "react-ipynb-renderer/dist/styles/onedork.css";

interface Props {
  /** Raw .ipynb file text (UTF-8 JSON). */
  source: string;
}

export function NotebookViewer({ source }: Props) {
  const { ipynb, error } = useMemo(() => {
    try {
      const parsed = JSON.parse(source) as Ipynb;
      return { ipynb: parsed, error: null };
    } catch (err) {
      return {
        ipynb: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [source]);

  if (error !== null || ipynb === null) {
    return (
      <div className="p-4 text-xs text-red-400">
        Notebook JSON could not be parsed{error ? `: ${error}` : ""}. Opening as plain text would
        show the raw file — close this viewer and re-open with the file listing to force a fallback
        renderer.
      </div>
    );
  }

  return (
    <div className="min-h-full bg-[#1e1e1e] px-4 py-3 text-[13px]">
      <IpynbRenderer ipynb={ipynb} syntaxTheme="vscDarkPlus" language="python" />
    </div>
  );
}
