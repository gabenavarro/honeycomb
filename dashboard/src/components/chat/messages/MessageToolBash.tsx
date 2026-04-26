import { Terminal } from "lucide-react";

import { tryParse } from "./_partialJson";
import { ToolBlockChrome } from "./ToolBlockChrome";

interface Props {
  block: {
    id: string;
    tool: string;
    input: Record<string, unknown>;
    partialJson: string;
    complete: boolean;
  };
}

export function MessageToolBash({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  const command = (parsed.command as string | undefined) ?? "";
  const description = parsed.description as string | undefined;
  return (
    <ToolBlockChrome
      icon={<Terminal size={11} />}
      name="Bash"
      target={description ?? null}
      accent="text-tool"
      borderAccent="border-tool/30"
      complete={block.complete}
    >
      <div className="space-y-1 font-mono text-[11.5px]">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Input</div>
        <pre className="whitespace-pre-wrap break-words rounded bg-input px-2 py-1 text-primary">
          {command}
        </pre>
      </div>
    </ToolBlockChrome>
  );
}
