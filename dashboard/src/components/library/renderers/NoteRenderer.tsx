/** Note artifact renderer (M35). Lighter chrome than PlanRenderer — h2 title only. */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function NoteRenderer({ artifact }: Props) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <header className="border-edge-soft border-b pb-2">
        <h1 className="text-primary text-[15px] font-semibold">{artifact.title}</h1>
        <p className="text-muted mt-1 text-[10px]">
          Note · {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>
      <MarkdownBody source={artifact.body} />
    </div>
  );
}
