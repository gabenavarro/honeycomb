/** AuthGate — the modal that accepts the Honeycomb bearer token.
 *
 * Shown whenever the dashboard has no token persisted (first load) or
 * when a 401 clears the existing one. We verify the pasted token by
 * calling /api/health with the Authorization header attached; if that
 * succeeds the token is persisted to localStorage and this component
 * unmounts.
 *
 * `/api/health` is intentionally the probe endpoint because it's the
 * only route the hub exempts from auth — but it still accepts the
 * Authorization header. A 200 response tells us two things:
 *   1. the hub is reachable,
 *   2. the token format doesn't upset any middleware (unlikely to
 *      fail since we don't inspect the value, but harmless to check).
 *
 * To verify the token is actually accepted we then hit a protected
 * route (`/api/containers`); a 200 there confirms the token is valid.
 * A 401 surfaces a specific error; anything else surfaces a generic
 * "hub unreachable" hint.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useAuthToken } from "../hooks/useAuthToken";
import { setAuthToken } from "../lib/auth";

type ProbeState = "idle" | "probing" | "error";

async function probeToken(token: string): Promise<{ ok: true } | { ok: false; message: string }> {
  // Ping a protected route to confirm the token is accepted. /api/containers
  // is an inexpensive read that exercises the full auth path.
  try {
    const res = await fetch("/api/containers", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) {
      return { ok: false, message: "The hub rejected this token." };
    }
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      message: `Hub returned ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Could not reach the hub (${err instanceof Error ? err.message : "unknown error"}).`,
    };
  }
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [token] = useAuthToken();
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<ProbeState>("idle");
  const [error, setError] = useState<string | null>(null);

  // Clear the draft whenever the token flips from set → null so the
  // next paste starts from an empty input. Keep it intact when the
  // user is actively editing.
  useEffect(() => {
    if (token === null && state === "idle") {
      setDraft("");
      setError(null);
    }
  }, [token, state]);

  if (token) {
    return <>{children}</>;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("Paste the token from the hub console.");
      return;
    }
    setState("probing");
    setError(null);
    const result = await probeToken(trimmed);
    if (result.ok) {
      setAuthToken(trimmed);
      setState("idle");
    } else {
      setError(result.message);
      setState("error");
    }
  }

  // Radix Dialog ``modal`` is always true and the gate stays open
  // while the token is missing — we never let the user dismiss without
  // pasting a valid token, so ``onOpenChange`` is a no-op.
  return (
    <Dialog.Root open modal>
      <Dialog.Portal>
        <Dialog.Overlay className="bg-page/95 fixed inset-0 z-50 backdrop-blur-sm" />
        <Dialog.Content
          className="bg-chip fixed top-1/2 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-md border border-white/10 p-6 shadow-2xl outline-none"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <form onSubmit={onSubmit}>
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-full bg-amber-500/10 p-2 text-amber-400">
                <KeyRound size={22} aria-hidden="true" />
              </div>
              <div>
                <Dialog.Title className="text-lg font-semibold text-white">
                  Paste your Honeycomb auth token
                </Dialog.Title>
                <Dialog.Description className="text-xs text-gray-400">
                  Shown once in the hub terminal on first start, and saved at
                  <code className="mx-1 rounded bg-black/30 px-1 py-0.5 font-mono text-[11px]">
                    ~/.config/honeycomb/token
                  </code>
                  .
                </Dialog.Description>
              </div>
            </div>

            <label
              className="mb-2 block text-xs tracking-wide text-gray-400 uppercase"
              htmlFor="token"
            >
              Bearer token
            </label>
            <input
              id="token"
              name="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (state === "error") setState("idle");
              }}
              placeholder="e.g. t9f…-long-random-string"
              className="bg-page w-full rounded border border-white/10 px-3 py-2 font-mono text-sm text-white outline-none focus:border-sky-500"
            />

            {error ? (
              <div
                role="alert"
                className="mt-3 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </div>
            ) : null}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="submit"
                disabled={state === "probing"}
                className="inline-flex items-center gap-2 rounded bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-60"
              >
                {state === "probing" ? (
                  <>
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    Checking…
                  </>
                ) : (
                  "Unlock dashboard"
                )}
              </button>
            </div>

            <p className="mt-4 border-t border-white/5 pt-3 text-[11px] leading-snug text-gray-500">
              The token is stored in this browser&apos;s localStorage under
              <code className="mx-1 font-mono text-[11px]">hive:auth:token</code>
              and attached as a Bearer header to every request + as a{" "}
              <code className="font-mono text-[11px]">?token=…</code> query param on every
              WebSocket. Clear it by running{" "}
              <code className="font-mono text-[11px]">
                localStorage.removeItem(&quot;hive:auth:token&quot;)
              </code>{" "}
              in devtools, or by visiting this dashboard in an incognito window.
            </p>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
