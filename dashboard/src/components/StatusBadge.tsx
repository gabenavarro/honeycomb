import type { AgentStatus, ContainerStatus } from "../lib/types";

const containerColors: Record<ContainerStatus, string> = {
  running: "bg-green-500",
  stopped: "bg-gray-500",
  starting: "bg-yellow-500",
  error: "bg-red-500",
  unknown: "bg-gray-600",
};

const agentColors: Record<AgentStatus, string> = {
  idle: "bg-green-400",
  busy: "bg-blue-500",
  error: "bg-red-500",
  unreachable: "bg-gray-500",
};

// Shape suffix alongside color so the badges remain distinguishable under
// color-vision differences. `●` = nominal, `◆` = transitional, `✖` = failure,
// `○` = inactive/unreachable.
const containerShapes: Record<ContainerStatus, string> = {
  running: "●",
  stopped: "○",
  starting: "◆",
  error: "✖",
  unknown: "?",
};

const agentShapes: Record<AgentStatus, string> = {
  idle: "●",
  busy: "◆",
  error: "✖",
  unreachable: "○",
};

export function ContainerStatusBadge({ status }: { status: ContainerStatus }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs"
      role="status"
      aria-label={`Container status: ${status}`}
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${containerColors[status]}`} />
      <span aria-hidden="true" className="text-[9px] text-gray-500">
        {containerShapes[status]}
      </span>
      {status}
    </span>
  );
}

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs"
      role="status"
      aria-label={`Agent status: ${status}`}
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${agentColors[status]}`} />
      <span aria-hidden="true" className="text-[9px] text-gray-500">
        {agentShapes[status]}
      </span>
      {status}
    </span>
  );
}

export function GpuBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-300"
      aria-label="GPU-enabled container"
      title="GPU-enabled container"
    >
      GPU
    </span>
  );
}
