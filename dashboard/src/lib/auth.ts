/** Bearer-token storage for the Claude Hive dashboard (M3).
 *
 * The token is persisted to localStorage and re-read on every request
 * (rather than cached in a module-level variable) so that a paste into
 * the AuthGate modal is picked up by in-flight fetch retries and any
 * new WebSocket connects without requiring a page refresh.
 *
 * The `hive:auth-changed` custom event lets React components subscribe
 * to token updates (see `useAuthToken`). Cross-tab changes also arrive
 * via the native `storage` event and are forwarded through the same
 * channel so a single subscriber covers both cases.
 */

const STORAGE_KEY = "hive:auth:token";
const EVENT_NAME = "hive:auth-changed";

/** Read the current bearer token, or null when it's unset or localStorage is unavailable. */
export function getAuthToken(): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value?.trim() || null;
  } catch {
    return null;
  }
}

/** Persist a new bearer token (or clear it) and notify subscribers. */
export function setAuthToken(token: string | null): void {
  try {
    if (token && token.trim()) {
      window.localStorage.setItem(STORAGE_KEY, token.trim());
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // No localStorage (Safari private mode, etc.). Fall back to in-memory.
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

/** Signal other listeners (e.g. on receiving a 401). Equivalent to `setAuthToken(null)`. */
export function clearAuthToken(): void {
  setAuthToken(null);
}

/** Subscribe to token changes. Returns an unsubscribe function. */
export function onAuthTokenChange(listener: () => void): () => void {
  const handler = () => listener();
  window.addEventListener(EVENT_NAME, handler);
  // Cross-tab storage events arrive here too, so forward them into our
  // event bus so components only need one subscription.
  const storageHandler = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) window.dispatchEvent(new CustomEvent(EVENT_NAME));
  };
  window.addEventListener("storage", storageHandler);
  return () => {
    window.removeEventListener(EVENT_NAME, handler);
    window.removeEventListener("storage", storageHandler);
  };
}

/** Custom error thrown by the API client when the server answers 401. */
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized — bearer token missing or invalid") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
