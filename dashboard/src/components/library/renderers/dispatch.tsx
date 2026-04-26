/** Per-type renderer dispatch (M35). Registry maps ArtifactType → component.
 *  Falls back to NoteRenderer for any unknown type (defensive — the
 *  Pydantic Literal on the hub side rejects unknowns at the API layer).
 */
import type { FC, ReactNode } from "react";
import type { Artifact, ArtifactType } from "../../../lib/types";
import { EditRenderer } from "./EditRenderer";
import { NoteRenderer } from "./NoteRenderer";
import { PlanRenderer } from "./PlanRenderer";
import { ReviewRenderer } from "./ReviewRenderer";
import { SkillRenderer } from "./SkillRenderer";
import { SnippetRenderer } from "./SnippetRenderer";
import { SpecRenderer } from "./SpecRenderer";
import { SubagentRenderer } from "./SubagentRenderer";

const REGISTRY: Record<ArtifactType, FC<{ artifact: Artifact }>> = {
  plan: PlanRenderer,
  review: ReviewRenderer,
  edit: EditRenderer,
  snippet: SnippetRenderer,
  note: NoteRenderer,
  skill: SkillRenderer,
  subagent: SubagentRenderer,
  spec: SpecRenderer,
};

export function renderArtifact(artifact: Artifact): ReactNode {
  const Cmp = REGISTRY[artifact.type] ?? NoteRenderer;
  return <Cmp artifact={artifact} />;
}
