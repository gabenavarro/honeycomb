/** Note artifact renderer (M35). Lighter chrome than PlanRenderer — h2 title only. */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function NoteRenderer({ artifact }: Props) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <header className="border-b border-edge-soft pb-2">
        <h1 className="text-[15px] font-semibold text-primary">{artifact.title}</h1>
        <p className="mt-1 text-[10px] text-muted">
          Note · {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>
      <MarkdownBody source={artifact.body} />
    </div>
  );
}
