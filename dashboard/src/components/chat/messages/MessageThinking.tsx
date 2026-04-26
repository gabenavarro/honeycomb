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
    <div className="border-edge-soft bg-card rounded border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Toggle thinking block"
        className="text-think hover:bg-chip flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px]"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <Sparkles size={11} />
        <span className="font-semibold tracking-wider uppercase">Thinking</span>
        {!open && <span className="text-muted truncate normal-case">{oneLine}</span>}
        {streaming && <span className="text-think ml-auto">streaming…</span>}
      </button>
      {open && (
        <pre className="border-edge-soft text-secondary border-t px-3 py-2 font-mono text-[11px] whitespace-pre-wrap italic">
          {thinking}
        </pre>
      )}
    </div>
  );
}
