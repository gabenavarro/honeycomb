/** Shared artifact type metadata (icons, accent colors, labels, ordering) — M35.
 *
 * Lifted from ArtifactCard.tsx so renderers and other components can
 * import the maps without importing the full card component.
 *
 * ALL_TYPES and TYPE_LABEL were previously duplicated in FilterChips.tsx
 * and MoreCustomizationSheet.tsx; they now live here as the single source
 * of truth.
 */
import type { ArtifactType } from "./types";

export const ALL_TYPES: ArtifactType[] = [
  "plan",
  "review",
  "edit",
  "snippet",
  "note",
  "skill",
  "subagent",
  "spec",
];

export const TYPE_LABEL: Record<ArtifactType, string> = {
  plan: "Plan",
  review: "Review",
  edit: "Edit",
  snippet: "Snippet",
  note: "Note",
  skill: "Skill",
  subagent: "Subagent",
  spec: "Spec",
};

export const TYPE_ICON: Record<ArtifactType, string> = {
  plan: "📋",
  review: "👁",
  edit: "✏️",
  snippet: "</>",
  note: "🗒",
  skill: "🛠",
  subagent: "🤝",
  spec: "📄",
};

export const TYPE_ACCENT: Record<ArtifactType, string> = {
  plan: "text-think",
  review: "text-claude",
  edit: "text-edit",
  snippet: "text-tool",
  note: "text-secondary",
  skill: "text-claude",
  subagent: "text-task",
  spec: "text-think",
};
