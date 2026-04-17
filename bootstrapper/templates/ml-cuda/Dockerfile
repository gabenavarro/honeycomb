# =============================================================================
# ML/CUDA base — PyTorch, HuggingFace, Lightning on Blackwell/CUDA 13.2
# =============================================================================
# The base stays on NVIDIA's CUDA image (required for GPU access). All
# other M6 hardening is applied: no ``curl | sh`` anywhere, uv copied
# from the official image, Node + gh via signed apt repos, hive-agent
# install fails loudly.
# =============================================================================

ARG CUDA_IMAGE=nvidia/cuda:13.2.0-devel-ubuntu24.04
ARG UV_VERSION=0.11.7

FROM ${CUDA_IMAGE} AS base

ARG DEBIAN_FRONTEND=noninteractive
ARG PYTHON_VERSION=3.12

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    jq \
    build-essential \
    openssh-client \
    ca-certificates \
    gnupg \
    software-properties-common \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Python from deadsnakes. The PPA is signed by an Ubuntu keyserver
# identity (``add-apt-repository`` fetches the key); subsequent apt
# updates verify signatures.
RUN add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
        python${PYTHON_VERSION} \
        python${PYTHON_VERSION}-venv \
        python${PYTHON_VERSION}-dev \
    && ln -sf /usr/bin/python${PYTHON_VERSION} /usr/bin/python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Node.js via NodeSource's signed apt repository. Stores the keyring
# once, then every ``apt update`` verifies signatures — materially
# different from ``curl … | bash`` sourcing an install script.
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg \
    && chmod go+r /usr/share/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI via signed apt repository.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# uv from the official image — no curl | sh.
COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION} /uv /uvx /usr/local/bin/

# Claude Code CLI.
RUN npm install -g @anthropic-ai/claude-code

# ML core dependencies via uv (bypasses PEP 668 explicitly).
RUN uv pip install --system \
    torch \
    torchvision \
    torchaudio \
    transformers \
    datasets \
    accelerate \
    pytorch-lightning \
    lightning \
    wandb \
    tensorboard \
    safetensors \
    peft \
    bitsandbytes \
    einops \
    scipy \
    numpy \
    pandas \
    matplotlib \
    seaborn \
    scikit-learn \
    jupyterlab

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
