import { Wrench } from "lucide-react";

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

export function MessageToolGeneric({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  return (
    <ToolBlockChrome
      icon={<Wrench size={11} />}
      name={block.tool}
      target={null}
      accent="text-tool"
      borderAccent="border-tool/30"
      complete={block.complete}
    >
      <pre className="text-secondary font-mono text-[11px] break-words whitespace-pre-wrap">
        {JSON.stringify(parsed, null, 2)}
      </pre>
    </ToolBlockChrome>
  );
}
