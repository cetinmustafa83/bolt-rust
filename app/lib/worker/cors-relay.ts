/**
 * CORS-aware fetch with automatic relay fallback.
 *
 * Since the backend is a plain Rust static/API server (no JS runtime), LLM
 * calls are made directly from the browser/worker to the provider APIs.
 * Providers that do not send CORS headers (e.g. api.openai.com,
 * api.codegpt.co) fail the first attempt with a network error; those
 * requests are transparently retried through the Rust backend's
 * `/api/llm-relay` streaming endpoint, which is not subject to browser CORS
 * constraints.
 *
 * The per-host decision is cached so every subsequent call to the same host
 * goes straight through the working path.
 */

let relayBase = '/api/llm-relay';

/** Test hook / configuration escape hatch. */
export function setRelayBase(base: string) {
  relayBase = base;
}

const directBlockedHosts = new Set<string>();

function isAbsoluteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Perform `fetch(url, init)` directly; if the browser blocks the request
 * (CORS / network), retry once through the Rust relay.
 */
export async function corsAwareFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!isAbsoluteHttpUrl(url)) {
    // Relative (same-origin) requests never have CORS problems.
    return fetch(url, init);
  }

  const host = hostOf(url);

  if (host && directBlockedHosts.has(host)) {
    return relayFetch(url, init);
  }

  try {
    return await fetch(url, init);
  } catch (error) {
    // A TypeError from fetch is how browsers surface CORS/network failures.
    if (error instanceof TypeError && host) {
      directBlockedHosts.add(host);

      return relayFetch(url, init);
    }

    throw error;
  }
}

/**
 * Unconditionally route the request through the Rust relay.
 * Streaming responses are passed through untouched.
 */
export async function relayFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);

  // Hop-by-hop / forbidden headers that cannot be forwarded manually.
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length');

  return fetch(relayBase, {
    method: init?.method ?? 'GET',
    headers: {
      ...Object.fromEntries(headers.entries()),
      'x-relay-url': url,
    },
    body: init?.body,
    signal: init?.signal,
  });
}
