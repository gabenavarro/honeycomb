import { createLogger, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite's internal /ws proxy error handler logs EPIPE/ECONNRESET stack
// traces unconditionally. These fire on every normal client reconnect
// (page reload, HMR swap, browser tab-suspend). The handlers we attach
// via `configure` run alongside Vite's, not before it, so the only
// reliable way to suppress the noise is to filter at the logger level.
const NOISY_PATTERNS = ["EPIPE", "ECONNRESET", "ERR_STREAM_WRITE_AFTER_END"];
const NOISY_CONTEXT = /ws proxy (error|socket error)/i;

function makeQuietLogger() {
  const base = createLogger();
  const origError = base.error.bind(base);
  base.error = (msg, opts) => {
    if (typeof msg === "string" && NOISY_CONTEXT.test(msg)) {
      if (NOISY_PATTERNS.some((p) => msg.includes(p))) {
        return; // swallow — benign reconnect artifact
      }
    }
    origError(msg, opts);
  };
  return base;
}

// Belt-and-suspenders: also attach no-op error listeners on the proxy
// itself so unhandled `Error` events don't propagate into Node's
// uncaughtException path (different failure mode from the log).
function quietWsProxy(proxy: { on: (event: string, cb: (...args: unknown[]) => void) => void }) {
  const swallow = (...args: unknown[]) => {
    const err = args[0];
    if (err && typeof err === "object" && "code" in err) {
      const code = (err as { code?: string }).code;
      if (code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_WRITE_AFTER_END") {
        return;
      }
    }
    console.warn("[vite:ws-proxy]", (err as Error | undefined)?.message ?? err);
  };
  proxy.on("error", swallow);
  proxy.on(
    "proxyReqWs",
    (
      _proxyReq: unknown,
      _req: unknown,
      socket: { on?: (ev: string, cb: (...a: unknown[]) => void) => void },
    ) => {
      socket.on?.("error", swallow);
    },
  );
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  customLogger: makeQuietLogger(),
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8420",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:8420",
        ws: true,
        configure: quietWsProxy,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
  },
});
