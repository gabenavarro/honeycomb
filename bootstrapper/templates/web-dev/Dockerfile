# =============================================================================
# Web Dev base — Node.js, Python, common web frameworks
# =============================================================================
FROM python:3.12-slim AS base

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    jq \
    build-essential \
    openssh-client \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm and yarn
RUN npm install -g pnpm yarn

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install Playwright for browser testing
RUN npx playwright install --with-deps chromium

# Python web dependencies
RUN pip install --no-cache-dir \
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

WORKDIR /workspace

# =============================================================================
# Development target
# =============================================================================
FROM base AS dev

RUN pip install --no-cache-dir hive-agent 2>/dev/null || true

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sleep", "infinity"]

# =============================================================================
# Production target
# =============================================================================
FROM base AS prod
