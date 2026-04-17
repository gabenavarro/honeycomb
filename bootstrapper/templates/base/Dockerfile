# =============================================================================
# Base stage — shared dependencies for all Claude Hive devcontainers
# =============================================================================
#
# Since M6 this Dockerfile deliberately avoids ``curl | sh`` for every
# tool install. The install paths are:
#   * Node.js comes from the base image (``node:22-bookworm-slim``).
#   * Python, git, build tools, openssh — from Debian Bookworm apt.
#   * uv is COPY-ed from the official ``ghcr.io/astral-sh/uv`` image
#     (signed, versioned, no script).
#   * GitHub CLI uses the official signed apt repository (the keyring
#     is downloaded once, verified by apt on every subsequent update).
#   * Claude Code CLI is installed with ``npm install -g``.
#   * hive-agent is installed via ``uv pip`` and the build fails loudly
#     on error rather than silently shipping a container that can't
#     heartbeat (a regression caught in the M4 review).
# =============================================================================

ARG NODE_IMAGE=node:22-bookworm-slim
# Bump UV_VERSION in lockstep with the host dev env so host + container
# resolve the same package versions. The value is consumed by the
# COPY --from below and by any ARG-aware CI check.
ARG UV_VERSION=0.11.7

FROM ${NODE_IMAGE} AS base

ARG DEBIAN_FRONTEND=noninteractive

# System packages. Bookworm ships Python 3.11, which is the minimum
# version both ``hub`` and ``hive-agent`` require.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    git \
    curl \
    wget \
    jq \
    build-essential \
    openssh-client \
    ca-certificates \
    gnupg \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI via the signed apt repository. Downloading the keyring is
# one-shot and every subsequent `apt update` verifies the stored key,
# so this is materially different from piping an install script.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# uv from the official image — versioned, signed, no install script.
# The two binaries (``uv`` + ``uvx``) land on PATH in one step.
COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION} /uv /uvx /usr/local/bin/

# Claude Code CLI.
RUN npm install -g @anthropic-ai/claude-code

# A non-root user is available for devcontainers that want it — set
# ``remoteUser: app`` in devcontainer.json to opt in. We stop short of
# ``USER app`` here because the shared ``claude-auth`` Docker volume
# mounts at ``/root/.claude`` and the hub reaches in as root via
# ``docker exec``; switching by default would break both paths.
RUN groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --shell /bin/bash --create-home app \
    && echo "app ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/app \
    && chmod 440 /etc/sudoers.d/app

WORKDIR /workspace

# =============================================================================
# Development target
#   Mount the repo at /workspace/<project>:
#     docker run ... -v $(pwd):/workspace/<project> <image>:dev
# =============================================================================
FROM base AS dev

# hive-agent is a hard dependency of the development experience — no
# silent failure. ``uv pip install --system`` bypasses Debian's
# externally-managed-environment guard explicitly rather than via
# ``pip --break-system-packages``, and uv already lives in the image.
RUN uv pip install --system hive-agent

# Start hive-agent on container startup (it dials the hub back via
# WebSocket — see M4).
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sleep", "infinity"]

# =============================================================================
# Production target
#   Project files baked in for reproducible runs.
# =============================================================================
FROM base AS prod
# Projects extend this stage and COPY their files in.
