import { FilePlus } from "lucide-react";
import { useState } from "react";

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

const PREVIEW_LINES = 8;

export function MessageToolWrite({ block }: Props) {
  const [expanded, setExpanded] = useState(false);
  const parsed = tryParse(block.partialJson) ?? block.input;
  const filePath = (parsed.file_path as string | undefined) ?? "(file)";
  const content = (parsed.content as string | undefined) ?? "";
  const lines = content.split("\n");
  const visible = expanded ? content : lines.slice(0, PREVIEW_LINES).join("\n");
  const hidden = lines.length - PREVIEW_LINES;
  return (
    <ToolBlockChrome
      icon={<FilePlus size={11} />}
      name="Write"
      target={filePath}
      accent="text-write"
      borderAccent="border-write/30"
      complete={block.complete}
    >
      <div className="space-y-1 font-mono text-[11.5px]">
        <pre className="bg-input text-primary rounded px-2 py-1 break-words whitespace-pre-wrap">
          {visible}
        </pre>
        {!expanded && hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-secondary hover:text-primary text-[10px]"
          >
            Show {hidden} more lines
          </button>
        )}
      </div>
    </ToolBlockChrome>
  );
}
