/** Edit artifact renderer (M35). Reuses M27's react-diff-view setup
 *  via DiffViewerTab for visual consistency.
 *
 *  Edit artifacts are synthesized at read-time from the diff_events
 *  table; their body is the unified-diff text and metadata.paths is
 *  the file list. Translates the Artifact shape back into the M27
 *  DiffEvent shape that DiffViewerTab expects.
 */
import { DiffViewerTab } from "../../DiffViewerTab";
import type { Artifact, DiffEvent } from "../../../lib/types";

interface Props {
  artifact: Artifact;
}

function artifactToDiffEvent(artifact: Artifact): DiffEvent {
  const metadata = artifact.metadata ?? {};
  const paths = (metadata.paths as string[] | undefined) ?? [];
  const tool = (metadata.tool as DiffEvent["tool"] | undefined) ?? "Edit";
  // Strip the synthesized "edit-" prefix to recover the original event_id
  const eventId = artifact.artifact_id.startsWith("edit-")
    ? artifact.artifact_id.slice("edit-".length)
    : artifact.artifact_id;
  return {
    event_id: eventId,
    container_id: artifact.container_id,
    claude_session_id: artifact.source_chat_id,
    tool_use_id: artifact.source_message_id ?? "",
    tool,
    path: paths[0] ?? "(file)",
    diff: artifact.body,
    added_lines: (metadata.lines_added as number | undefined) ?? 0,
    removed_lines: (metadata.lines_removed as number | undefined) ?? 0,
    size_bytes: (metadata.size_bytes as number | undefined) ?? artifact.body.length,
    timestamp: artifact.created_at,
    created_at: artifact.created_at,
  };
}

export function EditRenderer({ artifact }: Props) {
  const event = artifactToDiffEvent(artifact);
  return <DiffViewerTab event={event} onOpenFile={() => undefined} />;
}
