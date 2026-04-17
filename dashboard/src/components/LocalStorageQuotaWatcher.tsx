/** Listens for ``hive:localStorage:quota`` events from ``useLocalStorage``
 * and surfaces them as a single warning toast. Rate-limited so a storm
 * of failed writes (which happens when sessions grow past the quota)
 * doesn't drown the user in duplicate toasts. */

import { useEffect, useRef } from "react";

import { onLocalStorageQuota } from "../hooks/useLocalStorage";
import { useToasts } from "../hooks/useToasts";

const RATE_LIMIT_MS = 10_000;

export function LocalStorageQuotaWatcher() {
  const { toast } = useToasts();
  const lastToastAt = useRef(0);

  useEffect(() => {
    return onLocalStorageQuota(({ key }) => {
      const now = Date.now();
      if (now - lastToastAt.current < RATE_LIMIT_MS) return;
      lastToastAt.current = now;
      toast(
        "warning",
        "Browser storage full",
        `Could not persist "${key}". Recent changes remain in memory but will be lost on reload.`,
        8000,
      );
    });
  }, [toast]);

  return null;
}
