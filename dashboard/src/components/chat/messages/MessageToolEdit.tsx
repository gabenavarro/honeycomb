import { Pencil } from "lucide-react";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";

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

const COLLAPSE_THRESHOLD_LINES = 20;

function buildUnifiedDiff(oldText: string, newText: string, filePath: string): string {
  // Minimal unified-diff synthesis. react-diff-view's parseDiff
  // expects standard unified-diff text. We construct a single-hunk
  // diff covering the whole replacement; not byte-perfect but
  // sufficient for the visual treatment.
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const header = `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  const body =
    oldLines.map((l) => `-${l}`).join("\n") + "\n" + newLines.map((l) => `+${l}`).join("\n") + "\n";
  return header + body;
}

export function MessageToolEdit({ block }: Props) {
  const parsed = tryParse(block.partialJson) ?? block.input;
  const filePath = (parsed.file_path as string | undefined) ?? "(file)";
  const oldText = (parsed.old_string as string | undefined) ?? "";
  const newText = (parsed.new_string as string | undefined) ?? "";

  const totalLines = oldText.split("\n").length + newText.split("\n").length;
  const ready = block.complete && (oldText !== "" || newText !== "");

  let body: React.ReactNode;
  if (!ready) {
    body = <pre className="text-secondary">Streaming…</pre>;
  } else if (totalLines > COLLAPSE_THRESHOLD_LINES) {
    body = (
      <div className="text-secondary text-[11px]">
        <span className="font-mono">{filePath}</span> — {oldText.split("\n").length} →{" "}
        {newText.split("\n").length} lines
      </div>
    );
  } else {
    const unified = buildUnifiedDiff(oldText, newText, filePath);
    const files = parseDiff(unified, { nearbySequences: "zip" });
    body = (
      <div className="text-[11.5px]">
        {files.map((file, i) => (
          <Diff key={i} viewType="unified" diffType={file.type} hunks={file.hunks}>
            {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
          </Diff>
        ))}
      </div>
    );
  }

  return (
    <ToolBlockChrome
      icon={<Pencil size={11} />}
      name="Edit"
      target={filePath}
      accent="text-edit"
      borderAccent="border-edit/30"
      complete={block.complete}
    >
      {body}
    </ToolBlockChrome>
  );
}
