/** Compute a refetch interval that backs off exponentially on consecutive
 * errors, capping at `maxIntervalMs`. Pass the returned function as
 * `refetchInterval` to useQuery.
 *
 * Why: static intervals keep hammering the hub when it's down. This lets
 * a dead hub quiet down (every ~60s) without disabling polling entirely.
 */

import type { Query } from "@tanstack/react-query";

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  multiplier?: number;
}

export function backoffRefetch<TData, TError>(
  opts: BackoffOptions = {},
): (query: Query<TData, TError>) => number | false {
  const base = opts.baseMs ?? 5_000;
  const max = opts.maxMs ?? 60_000;
  const mult = opts.multiplier ?? 2;
  return (query) => {
    const fails = query.state.fetchFailureCount ?? 0;
    if (fails === 0) return base;
    const interval = Math.min(max, base * Math.pow(mult, fails));
    return interval;
  };
}
