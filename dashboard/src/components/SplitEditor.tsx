/** Side-by-side editor layout (M10).
 *
 * When the user flips the "split" toggle we render *two* containers
 * next to each other — the active tab on the left, the next-most-
 * recent tab on the right — using ``react-resizable-panels`` for a
 * drag handle. Closing either pane demotes the layout back to single.
 *
 * Keeping split-state outside the open-tab list means the user can
 * still use the tab strip normally; split only decides *how many*
 * open tabs are rendered at once. If there's only one open tab, the
 * split silently collapses to a single pane.
 */

import { Group, Panel, Separator } from "react-resizable-panels";

import { ErrorBoundary } from "./ErrorBoundary";
import { TerminalPane } from "./TerminalPane";
import type { ContainerRecord } from "../lib/types";

interface Props {
  primary: ContainerRecord;
  secondary: ContainerRecord | null;
  onCloseSecondary: () => void;
}

export function SplitEditor({ primary, secondary, onCloseSecondary }: Props) {
  if (secondary === null) {
    return <PaneBody container={primary} />;
  }
  return (
    <Group orientation="horizontal" id="hive-split-editor" style={{ flex: 1, minHeight: 0 }}>
      <Panel minSize={20} defaultSize={50}>
        <PaneBody container={primary} />
      </Panel>
      <Separator
        className="w-0.5 cursor-col-resize bg-[#2b2b2b] transition-colors hover:bg-[#0078d4]"
        aria-label="Resize split"
      />
      <Panel minSize={20} defaultSize={50}>
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-[#2b2b2b] bg-[#1e1e1e] px-2 py-1 text-[11px] text-[#858585]">
            <span className="truncate">{secondary.project_name}</span>
            <button
              type="button"
              onClick={onCloseSecondary}
              className="rounded px-1.5 hover:bg-[#2a2a2a] hover:text-[#e7e7e7]"
              aria-label="Close split pane"
              title="Close split"
            >
              ×
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <PaneBody container={secondary} />
          </div>
        </div>
      </Panel>
    </Group>
  );
}

function PaneBody({ container }: { container: ContainerRecord }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 p-2">
      <ErrorBoundary key={`eb-${container.id}`} label={`the ${container.project_name} terminal`}>
        <TerminalPane
          key={container.id}
          containerId={container.id}
          containerName={container.project_name}
          hasClaudeCli={container.has_claude_cli}
        />
      </ErrorBoundary>
    </div>
  );
}
