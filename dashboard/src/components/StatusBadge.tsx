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

// M20 — compact icon-only variants. Used in the container-tab header
// where horizontal room is scarce. Tooltip + aria-label carry the
// full status label so screen readers and mouse hovers still surface
// it. Keeps colour parity with the long-form badges above.

const containerTextColors: Record<ContainerStatus, string> = {
  running: "text-green-400",
  stopped: "text-gray-500",
  starting: "text-yellow-400",
  error: "text-red-400",
  unknown: "text-gray-600",
};

const agentTextColors: Record<AgentStatus, string> = {
  idle: "text-green-400",
  busy: "text-blue-400",
  error: "text-red-400",
  unreachable: "text-gray-500",
};

export function ContainerStatusDot({ status }: { status: ContainerStatus }) {
  return (
    <span
      className={`inline-flex items-center ${containerTextColors[status]}`}
      role="status"
      aria-label={`Container status: ${status}`}
      title={`Container ${status}`}
    >
      <span aria-hidden="true" className="text-[11px] leading-none">
        {containerShapes[status]}
      </span>
    </span>
  );
}

export function AgentStatusDot({ status }: { status: AgentStatus }) {
  return (
    <span
      className={`inline-flex items-center ${agentTextColors[status]}`}
      role="status"
      aria-label={`Agent status: ${status}`}
      title={`Agent ${status}`}
    >
      <span aria-hidden="true" className="text-[11px] leading-none">
        {agentShapes[status]}
      </span>
    </span>
  );
}

/** M20 — renders only when the container has something waiting on the
 * user (Claude prompt, ``(y/N)``, password entry, …). A gentle pulse
 * draws the eye without being annoying. */
export function NeedsAttentionIcon() {
  return (
    <span
      aria-label="Needs attention"
      title="Session is waiting for your input"
      className="inline-flex items-center"
    >
      <span
        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.85)]"
        aria-hidden="true"
      />
    </span>
  );
}
