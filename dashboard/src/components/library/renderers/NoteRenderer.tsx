/** Note artifact renderer (M35). Lighter chrome than PlanRenderer — h2 title only. */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function NoteRenderer({ artifact }: Props) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <header className="border-b border-edge-soft pb-2">
        <h2 className="text-[15px] font-semibold text-primary">{artifact.title}</h2>
        <p className="mt-1 text-[11px] text-muted">
          Note · saved {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>
      <MarkdownBody source={artifact.body} />
    </div>
  );
}
