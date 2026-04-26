/** Shared artifact type metadata (icons + accent colors) — M35.
 *
 * Lifted from ArtifactCard.tsx so renderers and other components can
 * import the maps without importing the full card component.
 */
import type { ArtifactType } from "./types";

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
