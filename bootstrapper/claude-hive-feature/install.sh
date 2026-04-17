#!/bin/bash
# =============================================================================
# Claude Hive — DevContainer Feature install script
# =============================================================================
# Invoked once during ``devcontainer up`` (or image build with the
# feature enabled). M6 hardening:
#
# * ``set -euo pipefail`` — any failed command, undefined variable, or
#   broken pipe aborts the install. Pre-M6 a ``set -e`` alone masked
#   failed pipes (``cmd1 | cmd2`` ignored cmd1's exit).
# * hive-agent install uses ``uv`` (fail-loud) instead of the old
#   ``pip ... 2>/dev/null || true`` that silently shipped containers
#   without an agent.
# * Idempotent — repeated invocations produce the same final state.
#   Re-running on an existing container doesn't duplicate the
#   /etc/environment line or append the API-key guard to every profile
#   twice.
# * Shell profile edits are guarded by a sentinel comment so a repeat
#   install doesn't balloon the profile.
# =============================================================================

set -euo pipefail

PROJECT_TYPE="${PROJECTTYPE:-base}"
INSTALL_SKILLS="${INSTALLSKILLS:-true}"
HUB_URL="${HUBURL:-http://host.docker.internal:8420}"

log() { echo "[claude-hive] $*"; }

log "Installing Claude Hive Feature (project_type=${PROJECT_TYPE})..."

# --- Claude Code CLI ---------------------------------------------------------
if ! command -v claude >/dev/null 2>&1; then
    log "Installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code
else
    log "Claude Code CLI already present, skipping."
fi

# --- hive-agent --------------------------------------------------------------
# Prefer uv (present on every M6+ base image); fall back to pip only if
# uv isn't installed. Either path fails loudly — no ``|| true``.
if ! command -v hive-agent >/dev/null 2>&1; then
    log "Installing hive-agent..."
    if command -v uv >/dev/null 2>&1; then
        uv pip install --system hive-agent
    else
        python3 -m pip install --break-system-packages hive-agent
    fi
else
    log "hive-agent already present, skipping."
fi

# --- /etc/environment (idempotent) ------------------------------------------
ENVIRONMENT_FILE=/etc/environment
ENV_SENTINEL="# claude-hive:start"
if ! grep -qF "${ENV_SENTINEL}" "${ENVIRONMENT_FILE}" 2>/dev/null; then
    log "Writing HIVE_HUB_URL to ${ENVIRONMENT_FILE}"
    # NOTE: HIVE_AUTH_TOKEN is deliberately not written here — the file
    # is world-readable. Tokens must come from devcontainer.json
    # remoteEnv (passed from the host) or the shell environment.
    cat >> "${ENVIRONMENT_FILE}" <<EOF
${ENV_SENTINEL}
HIVE_HUB_URL=${HUB_URL}
# claude-hive:end
EOF
fi

# --- Shell profile API-key guard (idempotent) --------------------------------
PROFILE_SENTINEL="# claude-hive:api-key-guard"
for PROFILE in /root/.bashrc /root/.zshrc /etc/bash.bashrc; do
    if [ ! -f "${PROFILE}" ]; then
        continue
    fi
    if grep -qF "${PROFILE_SENTINEL}" "${PROFILE}"; then
        continue
    fi
    cat >> "${PROFILE}" <<GUARD

${PROFILE_SENTINEL}
# Unset API key to enforce Max plan subscription auth. The hub's
# shared ``claude-auth`` Docker volume holds the OAuth credentials.
if [ -n "\${ANTHROPIC_API_KEY:-}" ]; then
    echo "[claude-hive] WARNING: Unsetting ANTHROPIC_API_KEY to use Max plan subscription auth"
    unset ANTHROPIC_API_KEY
fi
GUARD
done

# --- ~/.claude directory structure -------------------------------------------
CLAUDE_DIR="${HOME}/.claude"
mkdir -p \
    "${CLAUDE_DIR}/skills" \
    "${CLAUDE_DIR}/agents" \
    "${CLAUDE_DIR}/hooks" \
    "${CLAUDE_DIR}/rules"

# Default settings.json if the volume is empty.
if [ ! -f "${CLAUDE_DIR}/settings.json" ]; then
    cat > "${CLAUDE_DIR}/settings.json" <<'SETTINGS'
{
    "permissions": {
        "allow": [
            "Bash(git *)",
            "Bash(python *)",
            "Bash(pytest *)",
            "Bash(pip *)",
            "Bash(uv *)",
            "Bash(gh *)",
            "Bash(hive-agent *)",
            "Bash(npm *)",
            "Bash(node *)",
            "Read",
            "Write",
            "Edit",
            "Glob",
            "Grep"
        ]
    }
}
SETTINGS
fi

# --- Skills manifest report --------------------------------------------------
# Best-effort — a missing manifest is not an error; the hub will
# materialize one on first container start.
WORKSPACE_MANIFEST="${WORKSPACE_FOLDER:-/workspaces}"
MANIFEST_FILE=""
if [ -d "${WORKSPACE_MANIFEST}" ]; then
    MANIFEST_FILE="$(find "${WORKSPACE_MANIFEST}" -maxdepth 3 -type f -name skills_manifest.json 2>/dev/null | head -n1 || true)"
fi
if [ -n "${MANIFEST_FILE}" ] && [ -f "${MANIFEST_FILE}" ]; then
    SKILL_COUNT="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('skills',[])))" "${MANIFEST_FILE}" 2>/dev/null || echo 0)"
    PTYPE="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('project_type',''))" "${MANIFEST_FILE}" 2>/dev/null || echo unknown)"
    log "Skills manifest detected (project_type=${PTYPE}, ${SKILL_COUNT} skill(s) declared)."
    touch "${CLAUDE_DIR}/.skills_manifest_seen"
else
    log "No skills manifest found — provision the workspace via the hub to populate one."
fi

log "Claude Hive Feature installed successfully."
