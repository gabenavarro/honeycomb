#!/bin/bash
set -e

# ── Auth ──
# IMPORTANT: Do NOT set ANTHROPIC_API_KEY — it overrides Max subscription
# and causes pay-as-you-go API charges instead of using your plan.
#
# Auth is handled by the shared claude-auth volume mount at /root/.claude
# First-time login: run `claude` interactively in any container and
# complete the OAuth flow. Credentials persist in the shared volume.

# Guard against accidental API key contamination
if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "[auth] WARNING: ANTHROPIC_API_KEY is set!"
    echo "[auth] This overrides your Max subscription and incurs API charges."
    echo "[auth] Unsetting it to use subscription auth instead."
    unset ANTHROPIC_API_KEY
fi

# Check if logged in
if [ -f "/root/.claude/credentials.json" ] || [ -f "/root/.claude/.credentials.json" ]; then
    echo "[auth] Claude subscription credentials found"
else
    echo "[auth] WARNING: Not logged in yet."
    echo "[auth] Run: claude (interactively) and complete the OAuth login flow."
    echo "[auth] Credentials will be shared to all containers via the claude-auth volume."
fi

# GitHub CLI auth (token-based, no change needed)
if [ -n "$GITHUB_TOKEN" ]; then
    echo "$GITHUB_TOKEN" | gh auth login --with-token 2>/dev/null || true
    git config --global credential.helper "!gh auth git-credential"
fi

# Start hive-agent in background if HIVE_HUB_URL is set
if [ -n "${HIVE_HUB_URL:-}" ]; then
    echo "[hive] Starting hive-agent (hub=${HIVE_HUB_URL})..."
    hive-agent start --daemon
fi

# Execute the container's main command
exec "$@"
