/** WorkspacePicker (M32).
 *
 * Renders the list of registered containers as a clickable list,
 * each row showing a status dot, the project name, and the workspace
 * folder. Clicking a row selects that container as the active
 * workspace. Used as the contents of the WorkspacePill's popover.
 *
 * Status dot colors:
 *   - running   → green  (--color-write)
 *   - stopped   → muted  (--color-faint)
 *   - error     → red    (--color-task)
 *   - other     → muted  (default)
 */
import type { ContainerRecord } from "../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelect: (id: number) => void;
}

function statusState(status: string): "ok" | "stopped" | "error" | "unknown" {
  switch (status) {
    case "running":
      return "ok";
    case "stopped":
    case "exited":
      return "stopped";
    case "error":
    case "crashed":
      return "error";
    default:
      return "unknown";
  }
}

function StatusDot({ status }: { status: string }) {
  const state = statusState(status);
  const color =
    state === "ok"
      ? "bg-write"
      : state === "error"
        ? "bg-task"
        : state === "stopped"
          ? "bg-faint"
          : "bg-muted";
  return (
    <span
      data-testid="workspace-status-dot"
      data-state={state}
      className={`h-2 w-2 shrink-0 rounded-full ${color}`}
      aria-hidden="true"
    />
  );
}

export function WorkspacePicker({ containers, activeContainerId, onSelect }: Props) {
  if (containers.length === 0) {
    return (
      <div className="p-3 text-[12px] text-muted">
        <p>No workspaces registered.</p>
        <p className="mt-1 text-[11px] text-faint">
          Use the &quot;+ New&quot; button on the Containers sidebar to register one.
        </p>
      </div>
    );
  }

  return (
    <ul role="listbox" aria-label="Workspaces" className="flex max-h-80 flex-col overflow-y-auto py-1">
      {containers.map((c) => {
        const isActive = c.id === activeContainerId;
        return (
          <li key={c.id}>
            <button
              type="button"
              role="option"
              aria-selected={isActive}
              aria-current={isActive}
              onClick={() => onSelect(c.id)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                isActive
                  ? "bg-chip text-primary"
                  : "text-secondary hover:bg-chip hover:text-primary"
              }`}
            >
              <StatusDot status={c.container_status} />
              <span className="flex flex-1 flex-col overflow-hidden">
                <span className="truncate text-[12px] font-medium">{c.project_name}</span>
                <span className="truncate font-mono text-[10px] text-muted">{c.workspace_folder}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
