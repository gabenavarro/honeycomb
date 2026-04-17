# =============================================================================
# Computational Biology base — bioinformatics, single-cell, protein modeling
# =============================================================================
# Mirrors the M6 modernization in ``bootstrapper/templates/base``: no
# ``curl | sh``, uv copied from the official image, gh via signed apt
# repo, hive-agent install fails loudly.
# =============================================================================

ARG NODE_IMAGE=node:22-bookworm-slim
ARG UV_VERSION=0.11.7
ARG HIVE_AGENT_SOURCE=git+https://github.com/gabenavarro/honeycomb.git@main#subdirectory=hive-agent

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv_source

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
    gfortran \
    libhdf5-dev \
    libxml2-dev \
    libcurl4-openssl-dev \
    libssl-dev \
    zlib1g-dev \
    libbz2-dev \
    liblzma-dev \
    libffi-dev \
    samtools \
    bedtools \
    tabix \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI via signed apt.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# uv from the official image (via aliased stage — see base/Dockerfile).
COPY --from=uv_source /uv /uvx /usr/local/bin/

# Claude Code CLI.
RUN npm install -g @anthropic-ai/claude-code

# Bioinformatics Python stack via uv.
RUN uv pip install --system \
    biopython \
    scanpy \
    anndata \
    scvi-tools \
    scvelo \
    pydeseq2 \
    pysam \
    gget \
    bioservices \
    cobrapy \
    rdkit-pypi \
    datamol \
    scikit-bio \
    etetoolkit \
    numpy \
    scipy \
    pandas \
    matplotlib \
    seaborn \
    plotly \
    networkx \
    statsmodels \
    jupyterlab \
    pytest

RUN groupadd --gid 1001 app \
    && useradd --uid 1001 --gid 1001 --shell /bin/bash --create-home app \
    && echo "app ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/app \
    && chmod 440 /etc/sudoers.d/app

WORKDIR /workspace

# =============================================================================
# Development target
# =============================================================================
FROM base AS dev

ARG HIVE_AGENT_SOURCE
RUN uv pip install --system --break-system-packages "${HIVE_AGENT_SOURCE}"

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sleep", "infinity"]

# =============================================================================
# Production target
# =============================================================================
FROM base AS prod
