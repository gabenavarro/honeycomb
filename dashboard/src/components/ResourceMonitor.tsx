import { useQuery } from "@tanstack/react-query";
import { Cpu, HardDrive, MonitorDot } from "lucide-react";
import { getResources } from "../lib/api";
import type { ResourceStats } from "../lib/types";

interface Props {
  containerId: number;
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="h-1.5 w-full rounded-full bg-gray-800">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ResourceMonitor({ containerId }: Props) {
  const { data: stats } = useQuery({
    queryKey: ["resources", containerId],
    queryFn: () => getResources(containerId),
    refetchInterval: 5000,
  });

  if (!stats) {
    return (
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
        <p className="text-xs text-gray-600">No resource data available</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-gray-800 bg-gray-900 p-3">
      <h3 className="text-xs font-medium text-gray-400">Resources</h3>

      {/* CPU */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1 text-gray-500">
            <Cpu size={10} /> CPU
          </span>
          <span className="text-gray-400">{stats.cpu_percent.toFixed(1)}%</span>
        </div>
        <Bar
          value={stats.cpu_percent}
          max={100}
          color={
            stats.cpu_percent > 90
              ? "bg-red-500"
              : stats.cpu_percent > 70
                ? "bg-yellow-500"
                : "bg-blue-500"
          }
        />
      </div>

      {/* Memory */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1 text-gray-500">
            <HardDrive size={10} /> Memory
          </span>
          <span className="text-gray-400">
            {stats.memory_mb.toFixed(0)} / {stats.memory_limit_mb.toFixed(0)} MB
          </span>
        </div>
        <Bar
          value={stats.memory_percent}
          max={100}
          color={
            stats.memory_percent > 90
              ? "bg-red-500"
              : stats.memory_percent > 70
                ? "bg-yellow-500"
                : "bg-emerald-500"
          }
        />
      </div>

      {/* GPU */}
      {stats.gpu_utilization != null && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-1 text-gray-500">
              <MonitorDot size={10} /> GPU
            </span>
            <span className="text-gray-400">
              {stats.gpu_utilization.toFixed(0)}% — {stats.gpu_memory_mb?.toFixed(0)} /{" "}
              {stats.gpu_memory_total_mb?.toFixed(0)} MB
            </span>
          </div>
          <Bar
            value={stats.gpu_utilization}
            max={100}
            color={stats.gpu_utilization > 95 ? "bg-red-500" : "bg-amber-500"}
          />
        </div>
      )}
    </div>
  );
}
