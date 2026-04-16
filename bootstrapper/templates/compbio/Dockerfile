# =============================================================================
# Computational Biology base — bioinformatics, single-cell, protein modeling
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
    && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

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

# Core bioinformatics Python stack
RUN pip install --no-cache-dir \
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
