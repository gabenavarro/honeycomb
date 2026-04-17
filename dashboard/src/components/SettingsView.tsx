/** Live Settings view (M10).
 *
 * Reads every field from ``HiveSettings`` so the user sees the whole
 * hub configuration, but only lets them edit the subset the hub flagged
 * as mutable at runtime (``log_level``, ``discover_roots``,
 * ``metrics_enabled``). Non-mutable rows render disabled with a
 * tooltip explaining the restart requirement.
 *
 * Mutations go through the PATCH /api/settings endpoint; on success
 * the query cache is invalidated so a later view shows the persisted
 * values. Errors surface as a toast — the edit-in-progress state stays
 * so the user can retry without re-typing.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getSettings, patchSettings } from "../lib/api";
import type { HubSettingsPatch } from "../lib/types";
import { useToasts } from "../hooks/useToasts";

const LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const;

export function SettingsView() {
  const { toast } = useToasts();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
  });

  const [logLevel, setLogLevel] = useState<string>("INFO");
  const [discoverRoots, setDiscoverRoots] = useState<string>("");
  const [metricsEnabled, setMetricsEnabled] = useState<boolean>(true);

  // Sync editable fields from the server whenever the query resolves
  // or re-resolves (post-mutation).
  useEffect(() => {
    if (!data) return;
    const v = data.values;
    if (typeof v.log_level === "string") setLogLevel(v.log_level);
    if (Array.isArray(v.discover_roots))
      setDiscoverRoots((v.discover_roots as string[]).join("\n"));
    if (typeof v.metrics_enabled === "boolean") setMetricsEnabled(v.metrics_enabled);
  }, [data]);

  const mutation = useMutation({
    mutationFn: (patch: HubSettingsPatch) => patchSettings(patch),
    onSuccess: () => {
      toast("success", "Settings saved");
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) =>
      toast("error", "Settings save failed", err instanceof Error ? err.message : String(err)),
  });

  if (isLoading || !data) {
    return (
      <div className="p-4 text-xs text-[#858585]">
        {error ? `Failed to load settings: ${String(error)}` : "Loading settings…"}
      </div>
    );
  }

  const mutable = new Set(data.mutable_fields);
  const values = data.values as Record<string, unknown>;
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));

  const save = () => {
    const patch: HubSettingsPatch = {};
    const prevLevel = String(values.log_level ?? "");
    if (logLevel !== prevLevel) {
      patch.log_level = logLevel as HubSettingsPatch["log_level"];
    }
    const prevRoots = Array.isArray(values.discover_roots)
      ? (values.discover_roots as string[])
      : [];
    const parsedRoots = discoverRoots
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const rootsChanged =
      parsedRoots.length !== prevRoots.length || parsedRoots.some((p, i) => p !== prevRoots[i]);
    if (rootsChanged) patch.discover_roots = parsedRoots;
    const prevMetrics = Boolean(values.metrics_enabled);
    if (metricsEnabled !== prevMetrics) patch.metrics_enabled = metricsEnabled;

    if (Object.keys(patch).length === 0) {
      toast("info", "Nothing to save");
      return;
    }
    mutation.mutate(patch);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-[#2b2b2b] px-3 py-2">
        <h3 className="text-xs font-medium tracking-wider text-[#858585] uppercase">Settings</h3>
        <button
          type="button"
          onClick={save}
          disabled={mutation.isPending}
          className="rounded bg-[#0078d4] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#1188e0] disabled:opacity-50"
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3 text-xs">
        <div className="mb-6 space-y-3">
          <h4 className="text-[10px] font-semibold tracking-wider text-[#858585] uppercase">
            Editable
          </h4>
          <Row label="log_level" tooltip="Applied immediately; no restart needed.">
            <select
              value={logLevel}
              onChange={(e) => setLogLevel(e.target.value)}
              className="w-48 rounded border border-[#3c3c3c] bg-[#2a2a2a] px-2 py-1"
            >
              {LOG_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </Row>
          <Row
            label="discover_roots"
            tooltip="One path per line. Applied on the next /api/discover call."
          >
            <textarea
              value={discoverRoots}
              onChange={(e) => setDiscoverRoots(e.target.value)}
              rows={Math.max(3, discoverRoots.split("\n").length)}
              className="w-full rounded border border-[#3c3c3c] bg-[#2a2a2a] px-2 py-1 font-mono"
            />
          </Row>
          <Row label="metrics_enabled" tooltip="Flips the /metrics endpoint on the next scrape.">
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={metricsEnabled}
                onChange={(e) => setMetricsEnabled(e.target.checked)}
                className="h-4 w-4"
              />
              <span>{metricsEnabled ? "on" : "off"}</span>
            </label>
          </Row>
        </div>

        <div className="space-y-2">
          <h4 className="text-[10px] font-semibold tracking-wider text-[#858585] uppercase">
            Read-only (requires restart)
          </h4>
          {entries
            .filter(([k]) => !mutable.has(k))
            .map(([key, value]) => (
              <Row key={key} label={key} tooltip="Restart the hub to change this field.">
                <code className="block max-w-full overflow-x-auto rounded bg-[#2a2a2a] px-2 py-1 font-mono text-[11px] text-[#c0c0c0]">
                  {formatValue(key, value)}
                </code>
              </Row>
            ))}
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  tooltip,
  children,
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-start gap-3">
      <span
        className="pt-1 font-mono text-[11px] text-[#858585]"
        title={tooltip}
        aria-description={tooltip}
      >
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function formatValue(key: string, value: unknown): string {
  if (key === "auth_token" && typeof value === "string" && value.length > 0) {
    return `[redacted, length=${value.length}]`;
  }
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
