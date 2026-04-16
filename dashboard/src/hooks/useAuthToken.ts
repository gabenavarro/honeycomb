/** React hook that exposes the persisted Honeycomb bearer token.
 *
 * Thin wrapper over `dashboard/src/lib/auth.ts`. Everything stateful
 * lives in that module so plain non-React code paths (the REST client,
 * WebSocket URL builders) can read and write the token without
 * pulling in React.
 */

import { useEffect, useState } from "react";
import { getAuthToken, onAuthTokenChange, setAuthToken as setAuthTokenRaw } from "../lib/auth";

type SetToken = (token: string | null) => void;

export function useAuthToken(): [string | null, SetToken] {
  const [token, setToken] = useState<string | null>(() => getAuthToken());

  useEffect(() => {
    return onAuthTokenChange(() => setToken(getAuthToken()));
  }, []);

  return [token, setAuthTokenRaw];
}
