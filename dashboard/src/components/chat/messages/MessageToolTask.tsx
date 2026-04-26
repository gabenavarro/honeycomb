import { Bot } from "lucide-react";

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

export function MessageToolTask({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  const subagent = (parsed.subagent_type as string | undefined) ?? "agent";
  const description = (parsed.description as string | undefined) ?? "";
  const prompt = (parsed.prompt as string | undefined) ?? "";
  return (
    <ToolBlockChrome
      icon={<Bot size={11} />}
      name="Task"
      target={`→ ${subagent}: ${description}`}
      accent="text-task"
      borderAccent="border-task/30"
      complete={block.complete}
    >
      <details className="text-secondary text-[11.5px]">
        <summary className="text-muted cursor-pointer text-[10px] tracking-wider uppercase">
          Prompt
        </summary>
        <pre className="bg-input text-primary mt-1 rounded px-2 py-1 break-words whitespace-pre-wrap">
          {prompt}
        </pre>
      </details>
    </ToolBlockChrome>
  );
}
