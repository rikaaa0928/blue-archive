FROM mcr.microsoft.com/dotnet/sdk:10.0-noble AS builder

ENV DEBIAN_FRONTEND=noninteractive
ENV UV_LINK_MODE=copy

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    python3 \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG UPSTREAM_REF=v2.3.0
RUN git clone --filter=blob:none \
      https://github.com/ZM-Kimu/Blue-Archive-Asset-Downloader . \
    && git checkout --detach "${UPSTREAM_REF}" \
    && git submodule update --init --recursive \
    && uv sync --locked --no-dev

FROM mcr.microsoft.com/dotnet/sdk:10.0-noble

ENV DEBIAN_FRONTEND=noninteractive

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app /app
COPY extract-story-tables.py /opt/ba-story-tools/extract-story-tables.py

ENTRYPOINT ["uv", "run", "--no-sync", "ba-downloader"]
