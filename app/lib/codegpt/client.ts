/**
 * codegpt — CodeGPT cloud API client for bolt.diy.
 *
 * Ported from the `codegpt-pi` provider extension so the exact same backend
 * contract works inside bolt.diy:
 *
 * - Authentication is CodeGPT's own device flow (a browser URL plus a
 *   server-push SSE channel); session tokens do not expire.
 * - The model catalog is fetched dynamically from the public `/vscode/catalog`
 *   endpoint (no auth required) — same mapping incl. the Economy/Free/Premium
 *   tier suffix that is stripped again before hitting the wire.
 * - Inference goes straight to `api.codegpt.co/api/v1/chat/tools`. The
 *   OpenAI-shaped request produced by the AI SDK is rewritten into CodeGPT's
 *   `agentId/requestId/messages/tools` format, CodeGPT's OpenAI-format SSE is
 *   piped straight back, token usage is synthesized (CodeGPT bills
 *   server-side and never emits a usage chunk), and CodeGPT refusals (plan
 *   limits, credits) are reduced to a readable plain-text error body.
 */

import type { ModelInfo } from '~/lib/modules/llm/types';
import { corsAwareFetch } from '~/lib/worker/cors-relay';

/*
 * =============================================================================
 * Constants
 * =============================================================================
 */

export const CODEGPT_PROVIDER_NAME = 'CodeGPT';

/** Env var / cookie slot holding a CodeGPT session token. */
export const CODEGPT_SESSION_TOKEN_KEY = 'CODEGPT_SESSION_TOKEN';

/**
 * CodeGPT's base agent. Its `/chat/tools` route requires a UUID agentId; the
 * model is carried separately on the wire, so one base agent serves the whole
 * credits roster. Matches BASE_AGENT_ID in the CodeGPT bridge session route.
 */
const BASE_AGENT_ID = '2385a3fe-c991-4070-bac2-ecbad0840b70';

/**
 * Channel label the backend accepts for this bridge. Matches the official
 * VSCode/pi extension ('codegpt-pi') so /chat/tools treats us identically.
 */
const CHANNEL = 'codegpt-pi';

/** A far-future expiry (ms, 9999-12-31) means "does not expire". */
export const NEVER_EXPIRES_MS = 253402300799000;

/**
 * The model picker rows show the model id, and bolt.diy has no tier field —
 * the tier is appended to the id here and stripped by codegptFetch before the
 * request goes to CodeGPT. It never appears in a real CodeGPT model id.
 */
const TIER_SEPARATOR = '/';

/**
 * CodeGPT refusal codes for a spent plan or balance. Retrying cannot succeed,
 * but clients decide retries by matching error text (a "$500" in the copy
 * reads as HTTP 500), so these refusals carry "quota exceeded", which is
 * never retried.
 */
const HARD_LIMIT_CODES = new Set([
  'DAILY_INTERACTIONS_LIMIT_REACHED',
  'DAILY_CREDIT_USAGE_REACHED',
  'NOT_ENOUGH_CREDIT',
  'FREE_DAILY_LIMIT_REACHED',
]);

/** Matches the tier suffix appended to a model id; stripped before the wire. */
const TIER_SUFFIX_RE = /\/(economy|free|premium)$/i;

export const CODEGPT_BACKEND_URL = 'https://api.codegpt.co/api/v1';
export const CODEGPT_PLAYGROUND_URL = 'https://app.codegpt.co';

/**
 * Compact, picker-friendly context size: 1048576 -> "1.0M", 512000 -> "512K".
 * Mirrors formatContextSize in ModelSelector.tsx so the label and the picker
 * badge never disagree, and mirrors the Rust backend's catalog renderer so
 * both model sources produce identical labels.
 */
export function formatCodeGPTContextSize(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }

  if (tokens >= 1_000) {
    return `${Math.floor(tokens / 1_000)}K`;
  }

  return tokens.toString();
}

/** Stable-ish conversation id; only used for CodeGPT-side session grouping. */
const SESSION_ID = `bolt-${crypto.randomUUID().slice(0, 24)}`;

/*
 * =============================================================================
 * Wire helpers (ported from codegpt-nextjs core/harness)
 * =============================================================================
 */

/**
 * Normalize OpenAI tool definitions to CodeGPT's bare `{name,description,parameters}`
 * shape, keeping only portable JSON-Schema keywords.
 */
function toolsForBackend(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.flatMap((tool) => {
    const fn = (tool as any)?.type === 'function' ? (tool as any).function : tool;

    if (!fn || typeof fn.name !== 'string' || typeof fn.description !== 'string') {
      return [];
    }

    const parameters: Record<string, unknown> = { ...portableSchema(fn.parameters), type: 'object' };

    if (!parameters.properties) {
      parameters.properties = {};
    }

    return [{ name: fn.name, description: fn.description, parameters }];
  });
}

function portableSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const schema = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of ['type', 'description', 'format', 'nullable', 'minimum', 'maximum', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined) {
      out[key] = schema[key];
    }
  }

  if (Array.isArray(schema.enum)) {
    out.enum = schema.enum;
  }

  if (Array.isArray(schema.required)) {
    out.required = schema.required.filter((v) => typeof v === 'string');
  }

  if (schema.items) {
    out.items = portableSchema(schema.items);
  }

  if (Array.isArray(schema.anyOf)) {
    out.anyOf = schema.anyOf.map(portableSchema);
  }

  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, unknown>).map(([name, child]) => [
        name,
        portableSchema(child),
      ]),
    );
  }

  return out;
}

/*
 * Strip JSON-invalid control characters (strict model servers reject raw NUL/ESC).
 * Tool results strip NUL only, preserving the exact bytes edit tools match on.
 */
const JSON_UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const NUL_ONLY = /\u0000/g;

function sanitizeValue(value: unknown, fileContent: boolean): unknown {
  if (typeof value === 'string') {
    const re = fileContent ? NUL_ONLY : JSON_UNSAFE_CONTROL;
    re.lastIndex = 0;

    return re.test(value) ? value.replace(re, '') : value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, fileContent));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeValue(v, fileContent);
    }

    return out;
  }

  return value;
}

function sanitizeMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }

  return messages.map((m) => sanitizeValue(m, (m as any)?.role === 'tool'));
}

/*
 * =============================================================================
 * Model catalog
 * =============================================================================
 */

let cachedModels: ModelInfo[] | null = null;

/**
 * CodeGPT's Credits menu carries the tier as `badge` (Economy/Free/New!/Strong)
 * plus a `pro` flag (premium). bolt.diy has no tier field, so collapse it to
 * one word that answers "what does this cost": Economy, Free, or Premium.
 */
function tierOf(entry: any): 'Economy' | 'Free' | 'Premium' {
  const badge = typeof entry?.badge === 'string' ? entry.badge.toLowerCase() : '';

  if (badge === 'free') {
    return 'Free';
  }

  if (badge === 'economy') {
    return 'Economy';
  }

  return entry?.pro === true ? 'Premium' : 'Economy';
}

/**
 * The served catalog (`/vscode/catalog`) carries the credits menu plus per-model
 * facts. Public, no auth required. Falls back to the last successful catalog on
 * transient failures.
 */
export async function fetchCatalogModels(signal?: AbortSignal): Promise<ModelInfo[]> {
  const res = await corsAwareFetch(`${CODEGPT_BACKEND_URL}/vscode/catalog`, { signal });

  if (!res.ok) {
    if (cachedModels) {
      return cachedModels;
    }

    throw new Error(`CodeGPT catalog → HTTP ${res.status}`);
  }

  const feed: any = await res.json();
  const menu: any[] = Array.isArray(feed?.creditsMenu) ? feed.creditsMenu : [];
  const aliases: Record<string, string> = feed?.aliases ?? {};
  const facts: Record<string, any> = feed?.models ?? {};

  const models: ModelInfo[] = menu
    .filter((entry) => entry && typeof entry.id === 'string')
    .filter((entry) => {
      /*
       * Deployment policy: this build ships without any Anthropic/Claude tie.
       * If CodeGPT's shared catalog offers such models, keep them out of our
       * picker (mirrors the Rust backend's catalog filter).
       */
      const id = String(entry.id).toLowerCase();
      const display = String(entry.name ?? '').toLowerCase();

      return !(
        id.includes('claude') ||
        id.includes('anthropic') ||
        display.includes('claude') ||
        display.includes('anthropic')
      );
    })
    .map((entry): ModelInfo => {
      const identity = aliases[entry.id] ?? entry.id;
      const fact = facts[identity] ?? facts[entry.id] ?? {};
      const tier = tierOf(entry);
      const contextWindow = typeof fact.contextWindow === 'number' ? fact.contextWindow : 128000;

      /*
       * A completion budget can never exceed the context window; clamp so the
       * request builders' maxOutputTokens stay valid. Mirrors the Rust
       * backend's catalog renderer.
       */
      const maxOutput =
        typeof fact.maxOutput === 'number' && fact.maxOutput > 0
          ? Math.min(fact.maxOutput, contextWindow)
          : Math.min(32000, contextWindow);

      return {
        /*
         * Tier lives in the id so the picker row shows it; codegptFetch strips
         * it before the wire (see TIER_SEPARATOR).
         */
        name: `${entry.id}${TIER_SEPARATOR}${tier.toLowerCase()}`,
        label: `${typeof entry.name === 'string' && entry.name ? entry.name : entry.id} (${tier}, ${formatCodeGPTContextSize(contextWindow)} context)`,
        provider: CODEGPT_PROVIDER_NAME,
        maxTokenAllowed: contextWindow,
        maxCompletionTokens: maxOutput,
      };
    });

  if (!models.length) {
    if (cachedModels) {
      return cachedModels;
    }

    throw new Error('CodeGPT catalog returned no models');
  }

  cachedModels = models;

  return models;
}

/*
 * =============================================================================
 * Transport: AI SDK OpenAI stream -> CodeGPT /chat/tools
 * =============================================================================
 */

function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * CodeGPT refuses with its own body shape — plan walls send
 * `{title, subtitle, message, modal, code}`, others `{message}` or
 * `{error: {message}}`. Reduce it to the server's copy as a plain-text body so
 * the surfaced error reads naturally instead of echoing raw JSON.
 * Hard limits get a "(CodeGPT quota exceeded: <code>)" tag; see HARD_LIMIT_CODES.
 */
async function toReadableError(upstream: Response): Promise<Response> {
  const text = await upstream.text();

  let parsed: any;

  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  const detail =
    firstString(parsed?.message, parsed?.subtitle, parsed?.error?.message, parsed?.error) ??
    firstString(text) ??
    `CodeGPT request failed (HTTP ${upstream.status})`;

  const title = firstString(parsed?.title);
  const copy = title && !detail.startsWith(title) ? `${title}. ${detail}` : detail;
  const code = firstString(parsed?.code, parsed?.error?.code);
  const message = code && HARD_LIMIT_CODES.has(code) ? `${copy} (CodeGPT quota exceeded: ${code})` : copy;

  return new Response(message, { status: upstream.status, headers: { 'content-type': 'text/plain' } });
}

/**
 * CodeGPT's stream omits token usage (it bills server-side but never emits a
 * usage chunk), which leaves usage readouts at 0. Count the streamed output
 * and append an OpenAI usage chunk before [DONE]. Token counts are approximate
 * (chars/4); cost stays zero.
 */
function withUsageChunk(
  body: ReadableStream<Uint8Array>,
  model: unknown,
  promptTokens: number,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = '';
  let outputChars = 0;

  const forward = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const trimmed = line.trim();

    if (trimmed === 'data: [DONE]') {
      return;
    }

    if (trimmed.startsWith('data: ')) {
      try {
        const delta = JSON.parse(trimmed.slice(6))?.choices?.[0]?.delta;

        if (typeof delta?.content === 'string') {
          outputChars += delta.content.length;
        }

        if (Array.isArray(delta?.tool_calls)) {
          for (const call of delta.tool_calls) {
            outputChars += call?.function?.arguments?.length ?? 0;
          }
        }
      } catch {
        /* non-JSON frame */
      }
    }

    controller.enqueue(encoder.encode(line + '\n'));
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });

        let newline: number;

        while ((newline = buffer.indexOf('\n')) > -1) {
          forward(buffer.slice(0, newline), controller);
          buffer = buffer.slice(newline + 1);
        }
      },
      flush(controller) {
        buffer += decoder.decode();

        if (buffer) {
          forward(buffer, controller);
        }

        const completion = Math.max(1, Math.ceil(outputChars / 4));

        const usage = {
          id: 'chatcmpl-codegpt',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completion,
            total_tokens: promptTokens + completion,
          },
        };

        controller.enqueue(encoder.encode(`\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`));
      },
    }),
  );
}

/**
 * The custom `fetch` handed to the AI SDK's OpenAI client. Its only call is
 * the streaming `POST <baseUrl>/chat/completions`; send the CodeGPT equivalent
 * instead. The `authorization` header already carries the session token.
 */
export async function codegptFetch(_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  const body = JSON.parse(String(init?.body ?? '{}'));

  const wireModel = typeof body.model === 'string' ? body.model.replace(TIER_SUFFIX_RE, '') : body.model;
  const codegptMessages = sanitizeMessages(body.messages);
  const promptTokens = Math.ceil(JSON.stringify(codegptMessages).length / 4);

  const upstream = await corsAwareFetch(`${CODEGPT_BACKEND_URL}/chat/tools`, {
    method: 'POST',
    headers: {
      authorization: auth,
      'content-type': 'application/json',
      tokens: 'true',
      source: 'api',
      channel: CHANNEL,
    },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      session_id: SESSION_ID,
      agentId: BASE_AGENT_ID,
      model: wireModel,
      messages: codegptMessages,
      tools: toolsForBackend(body.tools),
      tool_choice: typeof body.tool_choice === 'string' ? body.tool_choice : undefined,
      client_tools_only: true,
      stream: true,
      format: 'json',
    }),
    signal: init?.signal,
  });

  if (!upstream.ok) {
    return toReadableError(upstream);
  }

  if (!upstream.body) {
    return upstream;
  }

  return new Response(withUsageChunk(upstream.body, wireModel, promptTokens), {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
}

/*
 * =============================================================================
 * Session state (chatbox connection indicator)
 * =============================================================================
 */

/**
 * Fired on the window whenever a CodeGPT request fails authentication (401,
 * unsigned session). The chatbox connection pill (APIKeyManager) listens for
 * this and switches to its red error state without reloading the page.
 */
export const CODEGPT_AUTH_ERROR_EVENT = 'codegpt:auth-error';

/** Notify the chatbox UI that CodeGPT rejected the session token. */
export function reportCodeGPTAuthError(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CODEGPT_AUTH_ERROR_EVENT));
  }
}

/** Validated-token cache so the chatbox pill does not re-probe every mount. */
const sessionValidationCache = new Map<string, { ok: boolean; at: number }>();
const SESSION_VALIDATION_TTL_MS = 60_000;

/**
 * Trust a token without a network probe — used right after a successful
 * device-flow login, where the token is fresh by construction and the check
 * icon should appear immediately.
 */
export function markCodeGPTSessionValid(token: string): void {
  sessionValidationCache.set(token.trim(), { ok: true, at: Date.now() });
}

/** Drop any cached validation result for a token (e.g. on sign out). */
export function invalidateCodeGPTSession(token: string): void {
  sessionValidationCache.delete(token.trim());
}

/**
 * Cheap authenticated probe driving the chatbox connection indicator:
 * `GET /user` answers 200 for a live session token and 401 for an invalid
 * one. Network hiccups fail open (the stored token is not proven bad by an
 * unreachable probe; real auth failures surface during chat and arrive via
 * `reportCodeGPTAuthError`).
 */
export async function validateCodeGPTSession(token: string, signal?: AbortSignal): Promise<boolean> {
  const trimmed = token.trim();

  if (!trimmed) {
    return false;
  }

  const cached = sessionValidationCache.get(trimmed);

  if (cached && Date.now() - cached.at < SESSION_VALIDATION_TTL_MS) {
    return cached.ok;
  }

  try {
    const res = await corsAwareFetch(`${CODEGPT_BACKEND_URL}/user`, {
      headers: { authorization: `Bearer ${trimmed}` },
      signal,
    });

    const ok = res.ok;

    sessionValidationCache.set(trimmed, { ok, at: Date.now() });

    return ok;
  } catch {
    if (cached) {
      sessionValidationCache.set(trimmed, { ...cached, at: Date.now() });

      return cached.ok;
    }

    return true;
  }
}

/**
 * Validate a CodeGPT session token before storing it. CodeGPT tokens are JWTs
 * signed by the platform; for the client the meaningful checks are shape and
 * sanity (three dot-separated parts, not a placeholder).
 */
export function isValidSessionTokenShape(token: string): boolean {
  const trimmed = token.trim();

  if (trimmed.length < 20 || trimmed.toLowerCase().includes('your_')) {
    return false;
  }

  const parts = trimmed.split('.');

  return parts.length === 3 && parts.every((part) => part.length > 0);
}

export { TIER_SUFFIX_RE };
