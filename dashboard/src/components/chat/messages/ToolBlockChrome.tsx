/** Shared chassis for all MessageTool* components (M33).
 *
 * Header: tool icon + name + target (one-liner) + status badge.
 * Body: caller-rendered children. Color comes from the `accent` prop
 * which maps to a Tailwind text token (text-tool / text-edit / text-read /
 * text-write / text-task / text-todo / text-think).
 */
import { CheckCircle, Loader2 } from "lucide-react";

import type { ReactNode } from "react";

interface Props {
  icon: ReactNode;
  name: string;
  target?: string | null;
  accent: string; // e.g. "text-tool" — Tailwind class
  borderAccent: string; // e.g. "border-tool/30"
  complete: boolean;
  children?: ReactNode;
}

export function ToolBlockChrome({
  icon,
  name,
  target,
  accent,
  borderAccent,
  complete,
  children,
}: Props) {
  return (
    <div className={`overflow-hidden rounded border ${borderAccent} bg-card`}>
      <header
        className={`flex items-center gap-2 border-b border-edge-soft bg-pane px-3 py-1 text-[11px] ${accent}`}
      >
        <span aria-hidden="true">{icon}</span>
        <span className="font-semibold uppercase tracking-wider">{name}</span>
        {target && (
          <span className="truncate font-mono text-secondary normal-case">{target}</span>
        )}
        <span className="ml-auto">
          {complete ? (
            <CheckCircle size={11} aria-label="Complete" />
          ) : (
            <Loader2 size={11} aria-label="Running" className="animate-spin" />
          )}
        </span>
      </header>
      {children && <div className="px-3 py-2 text-[12px] text-primary">{children}</div>}
    </div>
  );
}
