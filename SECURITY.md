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

## Known gaps in the current codebase

These are tracked and scheduled, not forgotten. Do not deploy Honeycomb on
an untrusted network until the referenced milestone has merged.

- `hive-agent` inside every container still binds `0.0.0.0:9100` with no
  auth and accepts arbitrary shell commands via `/exec`. (M4 replaces
  this with an authenticated reverse WebSocket tunnel.)
- The PTY endpoint interpolates its `cmd` query parameter into `sh -c`. (M5
  replaces it with a server-side enum.)
- `bootstrapper/provision.py` uses a non-sandboxed Jinja2 environment for
  user-supplied project descriptions. (M6)
- Dockerfile templates install `uv` via `curl | sh` and run every stage as
  `root`. (M6)

Until those milestones are merged: keep `HIVE_HOST=127.0.0.1`, keep your
bearer token secret, do not share Honeycomb containers across network
boundaries you do not trust, and do not paste untrusted strings into the
project-description field of the provisioner.

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
