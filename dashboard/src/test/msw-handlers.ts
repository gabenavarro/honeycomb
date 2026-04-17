/** MSW request handlers (M11).
 *
 * Central catalogue of hub API mocks that individual Vitest specs can
 * reuse instead of writing bespoke ``vi.fn()`` wrappers around
 * ``fetch``. The handlers are deliberately thin — they return enough
 * shape for the schema validators to pass; individual tests override
 * specific routes when they need a different response.
 *
 * Usage from a spec::
 *
 *     import { setupServer } from "msw/node";
 *     import { handlers } from "../test/msw-handlers";
 *
 *     const server = setupServer(...handlers);
 *     beforeAll(() => server.listen());
 *     afterEach(() => server.resetHandlers());
 *     afterAll(() => server.close());
 */

import { HttpResponse, http } from "msw";

export const handlers = [
  http.get("/api/containers", () => HttpResponse.json([])),
  http.get("/api/gitops/repos", () => HttpResponse.json([])),
  http.get("/api/gitops/prs", () => HttpResponse.json([])),
  http.get("/api/problems", () => HttpResponse.json({ problems: [] })),
  http.get("/api/settings", () =>
    HttpResponse.json({
      values: {
        log_level: "INFO",
        discover_roots: [],
        metrics_enabled: true,
        host: "127.0.0.1",
        port: 8420,
        auth_token: null,
        cors_origins: [],
      },
      mutable_fields: ["log_level", "discover_roots", "metrics_enabled"],
    }),
  ),
  http.get("/api/keybindings", () => HttpResponse.json({ bindings: {} })),
  http.get("/api/health", () =>
    HttpResponse.json({ status: "ok", version: "0.1.0", registered_containers: 0 }),
  ),
];
