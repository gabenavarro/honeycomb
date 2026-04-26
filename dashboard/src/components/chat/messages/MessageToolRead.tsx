import { FileText } from "lucide-react";

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

export function MessageToolRead({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  const filePath = (parsed.file_path as string | undefined) ?? "(file)";
  const offset = parsed.offset as number | undefined;
  const limit = parsed.limit as number | undefined;
  const range =
    offset !== undefined && limit !== undefined ? `lines ${offset}-${offset + limit}` : null;
  return (
    <ToolBlockChrome
      icon={<FileText size={11} />}
      name="Read"
      target={filePath}
      accent="text-read"
      borderAccent="border-read/30"
      complete={block.complete}
    >
      <div className="text-[11px] text-secondary">
        <span className="font-mono">{filePath}</span>
        {range && <span className="ml-2">{range}</span>}
      </div>
    </ToolBlockChrome>
  );
}
