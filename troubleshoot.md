# Claude Hive — Troubleshooting

Entries are structured as **Symptom → Cause → Fix**.

---

## Broken Dockerfile / stale devcontainer files from earlier provisioning

**Symptom.** `devcontainer up` fails with a confusing error, the Dockerfile
references files that aren't there, or provisioning writes into a workspace
that already has conflicting files.

**Cause.** A previous run left behind `.devcontainer/`, `CLAUDE.md`,
`.claude/`, or `.mcp.json` that no longer match the current templates.

**Fix.**

1. Delete the container record from the hub (dashboard trash icon or
   `DELETE /api/containers/{id}`).
2. Remove stale files from the workspace, for example:
   ```bash
   rm -rf <workspace>/.devcontainer
   rm -f  <workspace>/CLAUDE.md
   rm -rf <workspace>/.claude
   rm -f  <workspace>/.mcp.json
   ```
3. Restart the hub: `python hub/main.py`.
4. Create the container again via the dashboard.

The current provisioner guarantees:
- Dockerfiles use `pip install hive-agent` (not `COPY hive-agent/`).
- `entrypoint.sh` is copied into `.devcontainer/` only when we inject our
  template Dockerfile. If you bring your own Dockerfile with build
  context `..` (workspace root), you own the ENTRYPOINT.
- The build context for template Dockerfiles is `.devcontainer/` (where
  both the Dockerfile and `entrypoint.sh` live).

---

## Every command ends with `[exit 0] via docker_exec` — state doesn't persist

**Symptom.** Running `cd /src` then `pwd` shows `/` instead of `/src`.
`export VAR=x` then `echo $VAR` is empty. Interactive programs like
`claude /login`, `vim`, or `htop` fail immediately with "Unknown
command" / "not a tty" / other confusing messages.

**Cause.** You're in the **Claude → Quick** pane (or posting to
`/api/containers/{id}/commands`). That transport runs *one*
`docker exec` per command — a fresh shell each time, no TTY. It's the
right choice for scriptable one-shot prompts; it's the wrong choice
for interactive work.

**Fix.**

- **Shell** sub-tab is already a persistent PTY. `cd`, env vars, `vim`,
  `htop` all work. If you see `[exit 0] via docker_exec` in the Shell
  pane, your frontend is stale — hard-refresh the browser.
- For Claude interactive slash commands: switch the Claude pane from
  **Quick** to **Interactive** (toggle in the Claude pane's toolbar).
  That runs `claude` in a real TTY over a WebSocket PTY — `/login`,
  `/resume`, `/compact` all work.

---

## Hub logs "No supported WebSocket library detected" / WebSocket endpoints return 404

**Symptom.** Browser never connects to `/ws` or `/ws/pty/*`; hub logs
`WARNING: No supported WebSocket library detected. Please use "pip install 'uvicorn[standard]'"`.

**Cause.** Uvicorn doesn't include a WebSocket implementation by
default. Without one, uvicorn rejects WS upgrades with 404.

**Fix.**

```bash
pip install websockets    # or: pip install 'uvicorn[standard]'
```

Then restart `python hub/main.py`. All WebSocket features (command
output streaming, build output streaming, PTY sessions) come online.

---

## Terminal pane is a black rectangle / output not rendering

**Symptom.** The xterm.js output area is a solid dark rectangle after
opening a container tab. Commands complete (status pill in the session
tab header flickers green) but no text appears.

**Cause.** WebGL2 failed to initialize in the browser. Most common on
WSL2 configurations where the browser can't reach the GPU, or in
headless-forwarded setups.

**Fix.** Reload the page — the component logs
`[hive-xterm] WebGL unavailable, using DOM renderer` in the browser
console and falls back automatically on the next mount. If the black
rectangle persists after reload:

1. Open DevTools → Console and check for a WebGL-related error.
2. In a Chrome-based browser, visit `chrome://gpu` — if
   *WebGL2* is listed as "Software only" or "Disabled", hardware
   acceleration is off; enable it under Settings → System.
3. As a last resort, hard-force the DOM renderer by editing
   [dashboard/src/components/XTermOutput.tsx](./dashboard/src/components/XTermOutput.tsx) —
   remove the `term.loadAddon(webgl)` block.

---

## Claude tab says "Claude CLI is not installed"

**Symptom.** Switching to the Claude sub-tab shows a yellow banner
`Claude CLI is not installed in this container.` with an **Install**
button; the input is disabled.

**Cause.** The container was registered (likely via Discover) but does
not have `@anthropic-ai/claude-code` on PATH. The hub probes at
registration and stores the result on the record.

**Fix.** Click **Install** — the hub runs
`npm install -g @anthropic-ai/claude-code` via `docker exec`, then
re-probes. On success the banner disappears.

If the install reports
`npm is not installed in this container. Install Node.js first…`, the
base image has no Node runtime. Get one in via:

```
docker exec <cid> sh -lc 'apk add --no-cache nodejs npm'   # Alpine
docker exec <cid> sh -lc 'apt-get update && apt-get install -y nodejs npm'  # Debian/Ubuntu
```

Then click Install again.

---

## Commands fail on containers not started via the devcontainer CLI

**Symptom.** A discovered container (e.g. one started by plain
`docker run` or `docker compose up`) shows terminal output like:

```
[failed (exit=1)] via devcontainer_exec
```

**Cause.** `devcontainer exec --workspace-folder <path>` requires a real
host-side `.devcontainer/devcontainer.json`. Discovered ad-hoc containers
get assigned a pseudo `workspace_folder` like `/workspace/<name>` that
doesn't exist on the host, so the CLI errors with "Dev container config
not found".

**Fix.** Nothing to do — the relay now auto-skips `devcontainer_exec`
when the config file isn't present and falls through to `docker exec`
(`bash -lc`, with a retry on `sh -c` for Alpine-style minimal images).
Every command response carries a `relay_path` field so you can confirm
which path ran; `docker_exec` is the expected answer for these
containers.

If you *still* see a 502 with all three `agent_error`,
`devcontainer_error`, and `docker_error` populated, the container has
likely stopped — check `docker ps`, and restart or remove the record.

---

## Command reports `completed` but nothing happened

**Symptom.** POST `/api/containers/{id}/commands` returns 202 with
`status: completed` but the command never ran.

**Cause.** Both the hive-agent path and the `devcontainer exec` fallback
failed silently (pre-Phase-1 bug).

**Fix.** This is now surfaced as HTTP 502 with
`{"agent_error": ..., "devcontainer_error": ...}`. If you see 502:

- Check the agent has dialed the hub recently — the hub's
  ``AgentRegistry`` snapshot (``/api/discover/containers``) reports
  ``has_hive_agent: true`` iff a live WebSocket is registered.
- Check `devcontainer` is on `PATH` on the host
  (`npm install -g @devcontainers/cli`).
- Inspect hub logs for the specific failure.

---

## Container shows `running` but agent never heartbeat

**Symptom.** Container appears `running` forever, but no terminal output,
and `agent_status` stays `idle`.

**Cause.** hive-agent failed to start inside the container — misconfigured
`HIVE_HUB_URL` or `HIVE_AUTH_TOKEN`, or missing Python deps in the dev
stage. Since M4 the agent is a WebSocket client of the hub, so the
failure mode is "never dials the hub" rather than "listener port busy".

**Fix.** After the 60-second registration grace period, the hub marks the
container `unreachable`. To recover:

1. `docker exec -it <container_id> hive-agent start` — check for Python
   errors.
2. Verify `HIVE_HUB_URL` inside the container (should default to
   `http://host.docker.internal:8420`).
3. Check that the dev-stage Dockerfile ran `pip install hive-agent`.

---

## Second ML/CUDA container rejected with 409

**Symptom.** POST `/api/containers` returns 409 with a `gpu_owner` in the
detail when creating a second ml-cuda container.

**Cause.** Intentional — the host has one GPU. Silent sharing would cause
out-of-memory under concurrent training.

**Fix.** Either stop the existing GPU container first, or retry with
`force_gpu: true` in the request body if you understand the consequences
(the two will compete for VRAM).

---

## `InvalidStateTransition` error on start/stop

**Symptom.** A 409 with a message like
`Container X: cannot transition error -> running. Allowed from error: [...]`.

**Cause.** The registry enforces a state machine that forbids direct
`error → running` (containers must be re-started via the STARTING state).

**Fix.** Hit `POST /api/containers/{id}/start` — it performs the correct
`error → starting → running` sequence.

---

## Dashboard terminal just prints `[status] command_id`

**Symptom.** Terminal pane shows a single status line instead of streamed
output.

**Cause.** Pre-Phase-3 wiring — the dashboard wasn't subscribed to the
`cmd:{command_id}` WebSocket channel.

**Fix.** Fixed in `TerminalPane.tsx`. If you still see it, your
browser has a stale build — hard-refresh (Ctrl/Cmd+Shift+R).

---

## "No upstream" on Git Ops panel

**Symptom.** A repo shows "no upstream" instead of ahead/behind counts.

**Cause.** The current branch has no `@{upstream}` set. Not an error.

**Fix.** `git push -u origin <branch>` in the repo, or ignore — this is
only a display indicator.

---

## Vitest fails with `styleText` import error

**Symptom.**
`SyntaxError: The requested module 'node:util' does not provide an export named 'styleText'`.

**Cause.** Vitest 4 (via rolldown) needs Node ≥ 22. The repo pins no
specific Node version.

**Fix.** Upgrade Node: `nvm install 22 && nvm use 22`, then re-run
`pnpm test` / `npx vitest run`.

---

## Auth issues: containers can't use Claude subscription

See the **Authentication — Max Plan Subscription** section in
[CLAUDE.md](./CLAUDE.md). Briefly:

- Never set `ANTHROPIC_API_KEY` in any container env — it overrides the
  subscription and incurs API charges.
- Login once: `docker compose run --rm <container> claude`, follow OAuth.
- The shared `claude-auth` Docker volume mounted at `/root/.claude`
  propagates credentials to every container.

---

## Dashboard AuthGate keeps re-opening / I lost the bearer token

**Symptom.** The paste-your-token dialog shows on every page load even
after successfully unlocking once; or you never saved the token printed
on first hub start and now the dashboard is stuck.

**Cause.** The hub generates the token on first run and persists it to
`~/.config/honeycomb/token` (mode `0600`). The dashboard stores it in
`localStorage` under `hive:auth:token`. A 401 from the hub (stale or
wrong token) clears the client-side copy and re-opens the gate.

**Fix.**

1. Read the current token:
   ```bash
   cat ~/.config/honeycomb/token
   ```
   Paste it into the gate.
2. If the file is missing, regenerate it — delete the stale entry and
   restart the hub; it'll print a fresh token:
   ```bash
   rm -f ~/.config/honeycomb/token
   python hub/main.py   # new token is logged to stdout once
   ```
3. For CI / scripted runs, set `HIVE_AUTH_TOKEN=…` in the environment;
   that takes precedence over the file and is echoed back as
   `token_source=env` in the boot log.

---

## hive-agent doesn't connect over the reverse tunnel (container shows `agent: unreachable`)

**Symptom.** The container status is `running` but `agent_status` is
`unreachable`. The Problems panel shows an entry like `<name>
unreachable (never heartbeated)` 60 s after registration.

**Cause.** Since M4 the agent dials the hub over WebSocket at
`/api/agent/connect`; there is no HTTP listener inside the container to
probe. Common failure modes:
- The `hive-agent` package is missing inside the container (Dockerfile
  `RUN pip install hive-agent` step was removed or failed).
- The agent was started without `HIVE_HUB_URL` / `HIVE_AUTH_TOKEN`, so
  it can't resolve or authenticate to the hub.
- The container is on a Docker network that can't reach the hub's
  loopback bind (`HIVE_HOST=127.0.0.1` + `--network=host` is fine;
  bridge networks need the hub bound to a reachable address).

**Fix.**

1. Check the agent is installed:
   ```bash
   docker exec <container-id> hive-agent --version
   ```
2. Check its logs for connect errors:
   ```bash
   docker exec <container-id> journalctl -u hive-agent 2>/dev/null \
     || docker exec <container-id> cat /var/log/hive-agent.log 2>/dev/null \
     || docker logs <container-id> | tail -40
   ```
3. Verify the tunnel URL + token are plumbed into the container's
   environment (the DevContainer Feature sets these from the hub's
   inspect output on first build).
4. Start the agent manually to see the handshake:
   ```bash
   docker exec -e HIVE_HUB_URL=ws://host.docker.internal:8420 \
               -e HIVE_AUTH_TOKEN="$(cat ~/.config/honeycomb/token)" \
               <container-id> hive-agent start --foreground
   ```

---

## Settings view rejects an edit with "Invalid settings"

**Symptom.** Saving from the Settings view pops an error toast like
`Settings save failed: Invalid settings: …`.

**Cause.** The hub validates the merged settings against
`HiveSettings` via pydantic. A typoed `log_level` (e.g. `verbose`) or
non-string entries in `discover_roots` fail the `Literal` / type
constraint.

**Fix.**

- `log_level` must be one of `DEBUG`, `INFO`, `WARNING`, `ERROR`,
  `CRITICAL`.
- `discover_roots` is one path per line; blank lines are ignored.
- `metrics_enabled` is a boolean checkbox; no free-form value.

If a persisted override file is already invalid (e.g. hand-edited),
delete it and reboot:

```bash
rm ~/.config/honeycomb/settings.json
python hub/main.py
```

Immutable fields (`host`, `port`, `auth_token`, `cors_origins`, …) are
exposed read-only in the UI. To change them, set the matching `HIVE_*`
env var and restart.

---

## Playwright E2E fails locally but CI is green (or vice versa)

**Symptom.** `npx playwright test` times out waiting for the Vite dev
server, or the AuthGate spec fails with the dialog staying visible.

**Cause.** `playwright.config.ts` starts Vite on `127.0.0.1:5173` via
its `webServer` block. If a stale dev server is already bound to 5173
(e.g. a previous `npm run dev` in another terminal), Playwright's
`reuseExistingServer` picks it up — and that server proxies `/api` to
the real hub on 8420, not the Playwright mock.

**Fix.**

1. Kill stray dev servers: `lsof -ti :5173 | xargs kill`.
2. Re-run the specs: `cd dashboard && npx playwright test`.
3. If the auth-gate spec fails, download the `playwright-traces`
   artifact from CI to see the rendered DOM at failure time —
   `error-context.md` inside shows the exact locator mismatch.
