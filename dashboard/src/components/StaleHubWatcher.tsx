/** Warns when the running hub predates the dashboard's build (M20).
 *
 * Long-lived local hubs don't auto-reload when we merge new routes to
 * ``main``; the dashboard is rebuilt on every page reload, so a
 * skew is easy to hit (the Files activity 404 that sparked this was
 * exactly this bug). The bundled ``EXPECTED_HUB_VERSION`` is the
 * floor — any version equal or newer is fine. A lower version fires
 * a single sticky toast telling the operator to restart.
 *
 * The check is deliberately lenient about non-semver tags the hub may
 * eventually grow (``0.2.0-rc1``, git sha). We only compare major /
 * minor / patch; anything unparseable is treated as "unknown" and
 * skipped (better silent than spamming).
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { getHealth } from "../lib/api";
import { useToasts } from "../hooks/useToasts";

// Bumped in lockstep with hub/main.py::HUB_VERSION at every merge that
// adds a public route. Keep these two in sync.
export const EXPECTED_HUB_VERSION = "0.2.0";

function parseSemver(v: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function StaleHubWatcher() {
  const { toast } = useToasts();
  const warnedRef = useRef(false);

  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!health?.version) return;
    if (warnedRef.current) return;
    if (compareSemver(health.version, EXPECTED_HUB_VERSION) < 0) {
      warnedRef.current = true;
      toast(
        "warning",
        "Hub is running an older version",
        `Dashboard expects ≥ ${EXPECTED_HUB_VERSION}, hub reports ${health.version}. Routes added in newer milestones will 404 — restart the hub (Ctrl+C then re-run "python hub/main.py") to pick them up.`,
        12_000,
      );
    }
  }, [health, toast]);

  return null;
}
