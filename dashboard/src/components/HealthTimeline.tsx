/** Container-health timeline strip (M25).
 *
 * Three recharts sparklines (CPU · MEM · GPU) above ``SessionSubTabs``
 * showing the last 5 minutes of resource usage for the focused
 * container. Click the strip to open the existing ``ResourceMonitor``
 * in a Radix Popover for the full detail chart.
 *
 * The buffer comes from ``useResourceHistory`` which hydrates from
 * the hub's ring buffer on mount and appends each live ``/resources``
 * tick — so reloads and new Tailscale devices start with the same
 * 5-minute window the previous session saw.
 */

import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Activity } from "lucide-react";
import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

import { useResourceHistory } from "../hooks/useResourceHistory";
import type { ResourceStats } from "../lib/types";
import { ResourceMonitor } from "./ResourceMonitor";

interface Props {
  containerId: number;
}

interface SparklineSpec {
  label: "CPU" | "MEM" | "GPU";
  stroke: string;
  fill: string;
  data: Array<{ t: number; v: number }>;
  last: number;
  peak: number;
  testSlot: string;
  dim: boolean;
  tooltipExtra?: string;
}

function pickCpu(s: ResourceStats): number {
  return s.cpu_percent;
}
function pickMem(s: ResourceStats): number {
  return s.memory_percent;
}
function pickGpu(s: ResourceStats): number {
  return s.gpu_utilization ?? 0;
}

function asSeries(
  samples: ResourceStats[],
  pick: (s: ResourceStats) => number,
): Array<{ t: number; v: number }> {
  return samples.map((s, i) => ({ t: i, v: pick(s) }));
}

function peakOf(samples: ResourceStats[], pick: (s: ResourceStats) => number): number {
  let peak = 0;
  for (const s of samples) {
    const v = pick(s);
    if (v > peak) peak = v;
  }
  return peak;
}

function lastOf(samples: ResourceStats[], pick: (s: ResourceStats) => number): number {
  return samples.length === 0 ? 0 : pick(samples[samples.length - 1]);
}

export function HealthTimeline({ containerId }: Props) {
  const samples = useResourceHistory(containerId);

  const gpuMissing = useMemo(
    () =>
      samples.length > 0 &&
      samples.every(
        (s) => s.gpu_utilization === null || s.gpu_utilization === undefined,
      ),
    [samples],
  );

  const specs: SparklineSpec[] = useMemo(() => {
    if (samples.length === 0) return [];
    return [
      {
        label: "CPU",
        stroke: "#3b8eea",
        fill: "#3b8eea",
        data: asSeries(samples, pickCpu),
        last: Math.round(lastOf(samples, pickCpu)),
        peak: Math.round(peakOf(samples, pickCpu)),
        testSlot: "cpu-sparkline",
        dim: false,
      },
      {
        label: "MEM",
        stroke: "#23d18b",
        fill: "#23d18b",
        data: asSeries(samples, pickMem),
        last: Math.round(lastOf(samples, pickMem)),
        peak: Math.round(peakOf(samples, pickMem)),
        testSlot: "mem-sparkline",
        dim: false,
      },
      {
        label: "GPU",
        stroke: "#f5f543",
        fill: "#f5f543",
        data: gpuMissing ? [] : asSeries(samples, pickGpu),
        last: gpuMissing ? 0 : Math.round(lastOf(samples, pickGpu)),
        peak: gpuMissing ? 0 : Math.round(peakOf(samples, pickGpu)),
        testSlot: "gpu-sparkline",
        dim: gpuMissing,
        tooltipExtra: gpuMissing ? "GPU not attached" : undefined,
      },
    ];
  }, [samples, gpuMissing]);

  if (samples.length === 0) {
    return (
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[#2b2b2b] bg-[#1a1a1a] px-3 text-[10px] text-[#858585]">
        <Activity size={11} aria-hidden="true" />
        <span>Collecting health samples…</span>
      </div>
    );
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Open resource monitor"
            className="group flex h-11 w-full shrink-0 items-stretch gap-3 border-b border-[#2b2b2b] bg-[#1a1a1a] px-3 text-left hover:bg-[#222]"
          >
            {specs.map((s) => (
              <Sparkline key={s.label} spec={s} />
            ))}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="bottom"
            align="start"
            className="z-40 w-[360px] rounded border border-[#2b2b2b] bg-[#1e1e1e] p-3 shadow-lg"
          >
            <ResourceMonitor containerId={containerId} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Tooltip.Provider>
  );
}

function Sparkline({ spec }: { spec: SparklineSpec }) {
  const tooltipText = spec.tooltipExtra
    ? `${spec.label} — ${spec.tooltipExtra}`
    : `${spec.label} ${spec.last}% · peak ${spec.peak}% (last 5 min)`;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <div
          data-slot={spec.testSlot}
          className={`flex flex-1 items-center gap-2 text-[10px] ${spec.dim ? "opacity-40" : ""}`}
        >
          <span className="w-8 font-mono text-[#858585]">{spec.label}</span>
          <div className="h-full min-w-0 flex-1">
            {spec.data.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={spec.data}
                  margin={{ top: 4, right: 4, left: 4, bottom: 4 }}
                >
                  <YAxis hide domain={[0, 100]} />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke={spec.stroke}
                    fill={spec.fill}
                    fillOpacity={0.25}
                    isAnimationActive={false}
                    strokeWidth={1.5}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full w-full" aria-hidden="true" />
            )}
          </div>
          <span className="w-10 shrink-0 font-mono text-right text-[#c0c0c0]">{spec.last}%</span>
        </div>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="bottom"
          sideOffset={4}
          className="z-50 rounded bg-[#2d2d2d] px-2 py-1 text-[10px] text-[#cccccc]"
        >
          {tooltipText}
          <Tooltip.Arrow className="fill-[#2d2d2d]" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
