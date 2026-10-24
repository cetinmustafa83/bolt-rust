import type { Config } from '@react-router/dev/config';

/**
 * SPA mode: the backend is a plain Rust server (backend-rs) without a
 * JavaScript runtime, so there is no server rendering. The build emits a
 * static `index.html` plus the client bundle under build/client, which the
 * Rust server serves with an SPA fallback. All LLM orchestration runs in the
 * browser's Comlink chat worker; the light API surface (/api/models,
 * /api/health, /api/llm-relay, …) is implemented natively in Rust.
 */
export default {
  ssr: false,
} satisfies Config;
