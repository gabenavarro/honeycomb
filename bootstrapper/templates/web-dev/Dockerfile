# =============================================================================
# Web Dev base — Node.js, Python, common web frameworks
# =============================================================================
# Mirrors the M6 modernization in ``bootstrapper/templates/base``: no
# ``curl | sh``, uv copied from the official image, gh via signed apt
# repo, hive-agent install fails loudly.
# =============================================================================

ARG NODE_IMAGE=node:22-bookworm-slim
ARG UV_VERSION=0.11.7

FROM ${NODE_IMAGE} AS base

ARG DEBIAN_FRONTEND=noninteractive

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

# pnpm + yarn alongside the default npm.
RUN npm install -g pnpm yarn

# GitHub CLI via signed apt.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# uv from the official image.
COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION} /uv /uvx /usr/local/bin/

# Claude Code CLI + Playwright (brings its own Chromium download).
RUN npm install -g @anthropic-ai/claude-code \
    && npx --yes playwright install --with-deps chromium

# Python web stack via uv (bypasses Debian's PEP 668 guard explicitly).
RUN uv pip install --system \
    fastapi \
    uvicorn \
    httpx \
    sqlalchemy \
    alembic \
    pydantic \
    python-dotenv \
    celery \
    redis \
    pytest \
    ruff

RUN groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --shell /bin/bash --create-home app \
    && echo "app ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/app \
    && chmod 440 /etc/sudoers.d/app

WORKDIR /workspace

# =============================================================================
# Development target
# =============================================================================
FROM base AS dev

RUN uv pip install --system hive-agent

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sleep", "infinity"]

# =============================================================================
# Production target
# =============================================================================
FROM base AS prod
