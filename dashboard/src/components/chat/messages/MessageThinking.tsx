/** Thinking block (M33). Orange-tinted, collapsible, italic body. */
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { useState } from "react";

interface Props {
  thinking: string;
  streaming?: boolean;
}

export function MessageThinking({ thinking, streaming }: Props) {
  const [open, setOpen] = useState(false);
  const oneLine = thinking.split("\n")[0]?.slice(0, 120) ?? "";
  return (
    <div className="rounded border border-edge-soft bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Toggle thinking block"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-think hover:bg-chip"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Sparkles size={11} />
        <span className="font-semibold uppercase tracking-wider">Thinking</span>
        {!open && <span className="truncate text-muted normal-case">{oneLine}</span>}
        {streaming && <span className="ml-auto text-think">streaming…</span>}
      </button>
      {open && (
        <pre className="border-t border-edge-soft px-3 py-2 font-mono text-[11px] italic text-secondary whitespace-pre-wrap">
          {thinking}
        </pre>
      )}
    </div>
  );
}
