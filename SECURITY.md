# Security Policy

## Threat model

Honeycomb is designed to run **locally on a single trusted workstation**. Its
threat model assumes:

- The hub (FastAPI) binds to `127.0.0.1` by default and is not reachable from
  the LAN or the internet.
- The host's Docker socket is trusted.
- The host user running the hub is the only user with access to its HTTP +
  WebSocket endpoints.

Anything that breaks those assumptions — exposing the hub on `0.0.0.0`,
running Honeycomb on a shared / multi-user box, or port-forwarding a
container's hive-agent listener — is **out of scope for the current release**
and requires the hardening milestones (token auth, reverse-tunnel transport,
PTY command enum) to land first. See the roadmap milestones M3, M4, and M5.

## Authentication (since M3)

Every HTTP and WebSocket endpoint, except `/api/health`, `/openapi.json`,
and the Swagger UI, requires a bearer token. The token is resolved at
start-up in this order:

1. `HIVE_AUTH_TOKEN` environment variable (used in CI and multi-hub).
2. `~/.config/honeycomb/token` on disk (mode `0600`).
3. Auto-generated on first start, persisted to the file above, and
   printed **once** to stdout.

Paste the token into the dashboard's first-load modal — it is stored in
`localStorage` under `hive:auth:token` and attached as
`Authorization: Bearer …` on every request and as `?token=…` on every
WebSocket connect. `hive-agent` inside a container reads
`HIVE_AUTH_TOKEN` from its own environment; the devcontainer templates
pass the host value through so a single token covers the whole fleet.

Rotate by deleting the token file (or unsetting the env var) and
restarting — a fresh token is generated on the next boot.

## Worker transport (since M4)

The ``hive-agent`` inside a container no longer binds a local listener.
It dials an authenticated WebSocket to ``wss://<hub>/api/agent/connect``
and stays there for the lifetime of the container. The hub pushes
command-exec frames down that socket and consumes heartbeats, outputs,
and completion notices back.

Consequences:

* No port `9100` is exposed from the container, so nothing on the
  Docker bridge can reach the agent.
* The bearer token gates the agent handshake the same way it gates the
  dashboard WebSocket. An agent without ``HIVE_AUTH_TOKEN`` is
  immediately closed (1008).
* If the agent isn't connected (container booting, hub restarted, or
  the container has no hive-agent at all), the command relay falls
  back to ``devcontainer exec`` and then ``docker exec`` — the same
  ladder as before, just with the agent socket on top.

## PTY command allowlist (since M5)

The ``/ws/pty/{record_id}`` endpoint used to f-string its ``cmd`` query
parameter into ``sh -c "exec <cmd>"``. An attacker who could hit the
socket could inject shell metacharacters — ``?cmd=;rm -rf /`` would
actually execute.

Since M5, the endpoint resolves ``cmd`` through a static allowlist
(``hub/pty_commands.py``) of symbolic names (``shell``, ``bash``,
``sh``, ``claude``, ``python``, ``node``, ``pytest``, ``git``, ``uv``).
Each value maps to a fixed ``argv`` constant; unknown values — and any
value containing shell metacharacters — get a ``4400`` close at
handshake time. See ``hub/tests/test_pty_commands.py`` for the
regression matrix.

## Request-size limits (since M5)

Every user-supplied string field in ``hub/models/schemas.py`` now has
a ``max_length``. The most important one is
``CommandRequest.command`` (64 KiB), which used to be unbounded and
could have been abused to ship megabytes through the command relay.

## Template rendering (since M6)

``bootstrapper/provision.py`` now renders every CLAUDE.md through
:class:`jinja2.sandbox.SandboxedEnvironment`, with the context bound
to a typed :class:`TemplateContext` Pydantic model. An attacker who
controls the ``project_description`` can no longer reach into Python
— a payload like ``{{ ''.__class__.__mro__ }}`` renders as literal
text in the resulting Markdown. The regression matrix lives in
``bootstrapper/tests/test_provision_security.py``; drift from the
rendered templates is caught by
``bootstrapper/tests/test_template_goldens.py``.

## Dockerfile hardening (since M6)

The four Dockerfile templates (``base``, ``ml-cuda``, ``web-dev``,
``compbio``) drop the ``curl -LsSf https://astral.sh/uv/install.sh | sh``
pattern in favour of:

* Python, git, and system deps from apt (``*-bookworm-slim`` base, or
  ``nvidia/cuda:13.2.0-devel-ubuntu24.04`` for the GPU template).
* ``uv`` copied from the pinned official image
  (``ghcr.io/astral-sh/uv:0.11.7``) — no install script, no dynamic
  download at build time.
* GitHub CLI and Node.js (on the GPU base) installed through signed
  apt repositories: the keyring is downloaded once, then every
  ``apt update`` verifies signatures. This is materially different
  from ``curl | bash`` sourcing an install script.
* A non-root ``app`` user exists in every image (uid 1000, passwordless
  sudo). Default ``USER root`` is kept for backward compat with the
  ``claude-auth`` volume mount at ``/root/.claude``; devcontainer
  templates can opt into ``remoteUser: app`` if the workspace doesn't
  rely on root privileges.
* The dev-stage ``hive-agent`` install fails loudly (no more
  ``|| true`` masking a container that can't talk to the hub).

``claude-hive-feature/install.sh`` picked up ``set -euo pipefail``,
idempotent edits to ``/etc/environment`` and shell profiles, and the
same fail-loud ``hive-agent`` install.

## Known gaps in the current codebase

No security milestones remain open in the roadmap. Remaining work is
dashboard UX + operability (M7 – M12).

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** on the repository
(Security tab → Report a vulnerability) rather than opening a public issue.
Include:

1. A description of the issue.
2. Steps to reproduce.
3. The commit SHA you observed it on.
4. Your assessment of the blast radius.

We aim to acknowledge reports within 72 hours.

## Credentials in this repository

Honeycomb itself does not ship with any credentials. A `.env.example`
template is committed; the real `.env` file is covered by `.gitignore`
and must never be checked in. If you accidentally commit secrets, rotate
them immediately and rewrite history before pushing.

## Scanning

Every PR runs `gitleaks` in CI. To scan locally before committing:

```bash
gitleaks detect --source . --no-banner
```

If `gitleaks` is not installed, a minimal fallback is:

```bash
grep -RIn --exclude-dir=.git \
  -E 'ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,}|wandb_v1_[A-Za-z0-9]{10,}|hf_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9-]+|AKIA[A-Z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----' \
  .
```

`pre-commit install` wires the same scan into the local commit hook.
