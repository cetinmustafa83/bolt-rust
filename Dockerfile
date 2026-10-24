# syntax=docker/dockerfile:1

# ============================================================================
# bolt.diy — production image on the Rust backend (backend-rs / bolt-server).
#
# The runtime image contains ONLY:
#   1. the Rust `bolt-server` binary (static SPA serving + the light API
#      surface: /api/health, /api/models, /api/check-env-key,
#      /api/configured-providers, /api/llm-relay, /api/github-template,
#      /api/codegpt-login-channel/:id, /webcontainer/connect/:id)
#   2. the static SPA bundle produced by `react-router build` (build/client)
#
# There is no Node.js runtime in the final image, no Cloudflare workerd,
# and no SSR process — the model catalog (catalog.json) is compiled into
# the binary via include_str!, and all heavy LLM orchestration runs in the
# browser's Comlink chat worker.
#
# Build:   docker build -t bolt-ai:production --target bolt-ai-production .
# Run:     docker run -p 5173:5173 --env-file .env.local bolt-ai:production
# ============================================================================

# ----------------------------------------------------------------------------
# Stage 1 — frontend build (static SPA bundle under build/client)
# ----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app

ENV HUSKY=0 \
    CI=true

# pnpm is pinned via package.json#packageManager
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# git is needed by build-time scripts (git info / templates)
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# Build-time public env (baked into the client bundle at build time).
# VITE_PUBLIC_APP_URL is optional; Coolify/other PaaS can pass it as --build-arg.
ARG VITE_PUBLIC_APP_URL
ARG VITE_LOG_LEVEL=debug
ARG DEFAULT_NUM_CTX
ENV VITE_PUBLIC_APP_URL=${VITE_PUBLIC_APP_URL} \
    VITE_LOG_LEVEL=${VITE_LOG_LEVEL} \
    DEFAULT_NUM_CTX=${DEFAULT_NUM_CTX}

# 1) fetch the store first so dependency layers cache independently of source
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch

# 2) install + build
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm run build

# ----------------------------------------------------------------------------
# Stage 2 — Rust backend build (bolt-server release binary)
# ----------------------------------------------------------------------------
FROM rust:1-bookworm AS rust-build
WORKDIR /build

COPY backend-rs ./backend-rs
WORKDIR /build/backend-rs

# Registry/git downloads live in cache mounts, so rebuilds after source
# changes do not re-download the crate index. `cargo build` reads
# Cargo.lock for a fully pinned dependency graph.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --release

# ----------------------------------------------------------------------------
# Stage 3 — runtime: debian-slim + bolt-server + build/client. Nothing else.
# ----------------------------------------------------------------------------
FROM debian:bookworm-slim AS bolt-ai-production

# ca-certificates: TLS trust store for the relay/dynamic catalog fetches
#                 (reqwest is built with rustls).
# curl:           used by the container HEALTHCHECK below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system bolt \
  && useradd --system --gid bolt --create-home bolt

WORKDIR /app

# The binary serves `$(cwd)/build/client` — this exact layout is the contract.
COPY --from=rust-build /build/backend-rs/target/release/bolt-server /app/bolt-server
COPY --from=frontend-build /app/build/client /app/build/client
RUN chmod +x /app/bolt-server \
  && chown --recursive bolt:bolt /app

# PORT/HOST are read by bolt-server; RUST_LOG controls tracing output.
# API keys are NOT baked into the image — provide them at runtime with
# `docker run -e …` / compose environment / env_file (see docker-compose.yaml).
ENV PORT=5173 \
    HOST=0.0.0.0 \
    RUST_LOG=bolt_server=info,tower_http=warn \
    RUNNING_IN_DOCKER=true

USER bolt
EXPOSE 5173

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=5 \
  CMD curl -fsS http://localhost:5173/api/health || exit 1

CMD ["/app/bolt-server"]
