# Rust Backend Edition

This edition of bolt.diy has **no Cloudflare workerd / Node server runtime**:
the backend is a native **Rust (axum) server** and the LLM orchestration runs
inside the browser in a **Comlink web worker**. The default provider is
**CodeGPT** (OAuth device-flow login) and the default model is
`gpt-6.1-sol/premium`. There is no Anthropic/Claude binding anywhere (provider,
SDK, env keys, defaults, catalogs — all removed and structurally filtered).

## Architecture

| Layer | What | Where |
|---|---|---|
| Backend | Rust axum server (`bolt-server`): static SPA serving (COOP/COEP), `/api/health`, `/api/models`, `/api/check-env-key`, `/api/configured-providers`, `/api/llm-relay`, `/api/github-template`, `/api/codegpt-login-channel/:id` (SSE token supervisor), `/webcontainer/connect/:id`; unknown `/api/*` → 501 JSON | `backend-rs/` |
| LLM runtime | ai-sdk agent loop, MCP clients, plugin tools, personas, active memory — all in the browser via Comlink worker (same UIMessageChunk wire protocol the old `/api/chat` had) | `app/lib/worker/`, `app/workers/chat.worker.ts` |
| CodeGPT provider | OAuth device flow + URL session-token handoff + dynamic catalog (claude-filtered) | `app/lib/codegpt/` |
| Frontend | React Router 8 SPA (`ssr: false`) | `app/` |

The static model catalog (`backend-rs/catalog.json`) is embedded into the
binary via `include_str!`. If you change the TS provider registry, regenerate
it with `npx tsx scripts/dump-provider-catalog.ts` and rebuild the Rust binary.

## Requirements

- Node.js 22+ and pnpm 9 (`corepack enable` or `npm i -g pnpm@9`)
- Rust stable (any recent 1.8x toolchain; `rustup` recommended)
- Docker (optional, for container deployment)

## Build & run (local)

```bash
pnpm install                     # frontend deps (Node side)
pnpm dev                         # builds Rust backend, then runs BOTH:
                                 #   bolt-server  → http://127.0.0.1:5175
                                 #   vite dev     → http://localhost:5173
                                 #   (vite proxies /api/* + /webcontainer/*
                                 #    to the Rust server; COOP/COEP headers
                                 #    mirror production)
```

`pnpm dev` requirements: Rust on PATH (`rustup`). Without cargo it degrades
to UI-only dev (`[dev] cargo not found…`); without Node it won't start at all.
Ports are overridable: `DEV_UI_PORT=5183 DEV_RUST_PORT=5176 pnpm dev`.
`SKIP_RUST_BUILD=1 pnpm dev` skips the cargo step (uses the existing binary).

Production (what `pnpm start` / Docker run):

```bash
pnpm install                     # frontend deps
pnpm run build                   # SPA -> build/client

cd backend-rs
cargo build --release            # -> backend-rs/target/release/bolt-server
cd ..

pnpm start                       # runs ./backend-rs/target/release/bolt-server
# env: PORT (default 5173), HOST (default 0.0.0.0), RUST_LOG
```

Then open `http://localhost:5173`. Add your provider API key(s) in the UI
(key icon) or via env vars — or just **Sign in with CodeGPT** (the amber pill
above the chat box) and start building.

Other scripts: `pnpm dev:ui` (Vite only — API falls back to browser-side
implementations), `pnpm backend:build` (cargo build only).

## Docker

```bash
docker build -t bolt-ai:latest .       # 3-stage: SPA build -> cargo release -> slim runtime
docker compose up -d                   # single `app` service, optional env_file
```

The production image contains only the `bolt-server` binary + `build/client`
(no Node runtime, no SSR). Provider env vars (`GROQ_API_KEY`, `OPENAI_API_KEY`,
…) are passed through by `docker-compose.yaml`; there is intentionally no
`ANTHROPIC_API_KEY` entry.

## What was removed vs upstream

- Cloudflare workerd/miniflare/wrangler runtime and all `api.*` Remix server
  routes (the Rust server + browser worker replace them)
- `@ai-sdk/anthropic` dependency, Anthropic provider, Anthropic icons/env
  keys, claude entries in static + dynamic catalogs (structurally filtered in
  `backend-rs/src/catalog.rs` and `app/lib/codegpt/client.ts`)
- Mock/demo endpoints (e.g. the random-data `api.system.disk-info` route)

## CodeGPT login flow (technical note)

CodeGPT pushes the session token **once** on a pub/sub channel
(`GET api.codegpt.co/api/v1/extensions/connection/:id`). This edition hosts
that SSE read in a Rust-side supervisor (`backend-rs/src/login_channel.rs`)
that reconnects with a ~400ms gap and caches the credentials; the browser
polls it every 2s, so the token can never be missed (Chromium tears down idle
browser SSE streams — the original bug this fixes).
