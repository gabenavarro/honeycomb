/** Error boundary around the editor pane (M8).
 *
 * Before M8 a child exception blanked the whole app — any crash in a
 * PTY pane, a command-output renderer, or a xterm.js write loop took
 * the dashboard down until the user reloaded. The boundary below
 * catches such crashes, displays a reset card with the error message,
 * and lets the user recover with a button click (or Enter/Space) that
 * remounts the editor subtree.
 *
 * React still has no hooks-based error boundary API, so this stays a
 * class component. Scope it tight — wrap only the editor subtree,
 * not the whole app — so errors outside it (navigation, sidebar
 * queries) surface via the normal Query/Toast paths instead of
 * disappearing into a boundary.
 */

import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Optional label shown in the fallback UI. Defaults to "the editor". */
  label?: string;
  /** Called with every caught error; useful for tests + logging hooks. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to console so the developer sees a real stack trace during
    // local work. Production builds can hook ``onError`` into a logger
    // or toast system.
    // eslint-disable-next-line no-console
    console.error("[error-boundary]", error, info);
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    const label = this.props.label ?? "the editor";
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      >
        <AlertTriangle size={28} className="text-amber-400" aria-hidden="true" />
        <div>
          <h2 className="text-sm font-semibold text-[#e7e7e7]">Something broke in {label}.</h2>
          <p className="mt-1 max-w-md text-[11px] text-[#858585]">{error.message || error.name}</p>
        </div>
        <button
          type="button"
          onClick={this.reset}
          className="inline-flex items-center gap-1.5 rounded border border-[#3a3a3a] bg-[#2d2d2d] px-3 py-1 text-xs text-[#cccccc] hover:bg-[#353535] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0078d4]"
        >
          <RotateCcw size={11} aria-hidden="true" />
          Try again
        </button>
        <p className="text-[10px] text-[#666]">
          If the problem persists, reload the dashboard or check the hub log.
        </p>
      </div>
    );
  }
}
