/**
 * CodeGPT OAuth (device flow) for the browser.
 *
 * Ported from `codegpt-pi`'s loginCodeGPT: mint a connection id, send the
 * user's browser to the playground login carrying it, then wait on the
 * backend's SSE channel until the completed login pushes the tokens.
 *
 * IMPORTANT: the login URL must carry the exact params the official VSCode
 * extension sends (`source=vscode`, `distinct_id=codegpt-pi`). CodeGPT's login
 * page only completes the extension device handshake — pushing the session
 * token to the `/extensions/connection/:id` SSE channel — for sources it
 * recognizes; any other source lands the user in the web dashboard without a
 * token push and the channel never resolves.
 *
 * Browser adaptation: the login URL is opened in a popup window (falls back to
 * a regular tab when popup creation is blocked), and the SSE channel is read
 * through `corsAwareFetch` so it transparently relays via the Rust backend if
 * CodeGPT's API does not send CORS headers.
 */

import Cookies from 'js-cookie';

import {
  CODEGPT_BACKEND_URL,
  CODEGPT_PLAYGROUND_URL,
  CODEGPT_PROVIDER_NAME,
  NEVER_EXPIRES_MS,
  isValidSessionTokenShape,
} from './client';
import { API_KEYS_UPDATED_EVENT, type ApiKeysUpdatedDetail, getApiKeysFromCookies } from '~/lib/api/apiKeys';
import { corsAwareFetch } from '~/lib/worker/cors-relay';

export interface CodeGPTCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export interface DeviceFlowCallbacks {
  /** Called once with the URL the user has to open and human instructions. */
  onAuth?: (auth: { url: string; instructions: string }) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

function normalizeExpiry(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value; // seconds vs ms
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);

    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return NEVER_EXPIRES_MS;
}

function openLoginWindow(url: string): Window | null {
  // Centered popup, 480x640 — comfortable for CodeGPT's login page.
  const width = 480;
  const height = 640;
  const y = Math.max(0, Math.floor((window.top?.outerHeight ?? height) / 2 + (window.top?.screenY ?? 0) - height / 2));
  const x = Math.max(0, Math.floor((window.top?.outerWidth ?? width) / 2 + (window.top?.screenX ?? 0) - width / 2));

  const popup = window.open(
    url,
    'codegpt-oauth-login',
    `popup=yes,width=${width},height=${height},left=${x},top=${y},noopener,noreferrer`,
  );

  if (popup) {
    try {
      popup.focus();
    } catch {
      /* focus may fail for cross-origin windows; harmless */
    }
  }

  return popup;
}

/**
 * Persist credentials into the shared `apiKeys` cookie store under the
 * provider name, exactly like a manually-entered API key, and notify the app
 * so the model selector refreshes.
 */
export function storeCodeGPTCredentials(credentials: CodeGPTCredentials): void {
  const currentKeys = getApiKeysFromCookies();
  const newKeys = { ...currentKeys, [CODEGPT_PROVIDER_NAME]: credentials.access };

  Cookies.set('apiKeys', JSON.stringify(newKeys), { expires: 365, sameSite: 'lax' });
  window.dispatchEvent(
    new CustomEvent<ApiKeysUpdatedDetail>(API_KEYS_UPDATED_EVENT, {
      detail: { apiKeys: newKeys, providerName: CODEGPT_PROVIDER_NAME },
    }),
  );
}

/** Overall deadline for the device flow — the user may sign in slowly, but not forever. */
const LOGIN_DEADLINE_MS = 5 * 60 * 1000;

/** Delay before reconnecting a dropped/ended login channel (EventSource-style). */
const RECONNECT_DELAY_MS = 1500;

/** How often the browser asks the backend supervisor whether the token arrived. */
const SUPERVISOR_POLL_INTERVAL_MS = 2000;

/**
 * Open the login SSE channel once and parse frames until tokens arrive.
 * Returns the credentials, or `null` when the channel ended without tokens
 * (caller reconnects). Setup failures (HTTP errors) throw — those are fatal.
 * Mid-stream network failures also throw; the caller treats them as a dropped
 * channel and reconnects, exactly like EventSource would.
 */
async function readLoginChannelOnce(
  connectionId: string,
  signal: AbortSignal | undefined,
): Promise<CodeGPTCredentials | null> {
  const res = await corsAwareFetch(`${CODEGPT_BACKEND_URL}/extensions/connection/${connectionId}`, {
    headers: { accept: 'text/event-stream' },
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`CodeGPT login channel failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      return null; // channel ended without tokens — reconnect
    }

    buffer += decoder.decode(value, { stream: true });

    let newline: number;

    while ((newline = buffer.indexOf('\n')) > -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);

      const match = line.match(/^data:\s*(.*)$/);

      if (!match || !match[1]) {
        continue; // keep-alive / comment frame
      }

      let payload: any;

      try {
        payload = JSON.parse(match[1]);
      } catch {
        continue; // keep-alive / comment frame
      }

      if (!payload?.access_token) {
        continue;
      }

      try {
        await reader.cancel();
      } catch {
        /* stream already closing */
      }

      const credentials: CodeGPTCredentials = {
        access: payload.access_token,
        refresh: payload.refresh_token ?? payload.access_token,
        expires: normalizeExpiry(payload.expires_at),
      };

      if (!isValidSessionTokenShape(credentials.access)) {
        throw new Error('CodeGPT login returned an unexpected token shape');
      }

      return credentials;
    }
  }
}

/**
 * Legacy fallback for backends without the login-channel supervisor: hold the
 * SSE read in the browser (EventSource-style auto-reconnect). A push landing
 * inside a reconnect gap is lost — that is exactly why the server-side
 * supervisor is the primary path.
 */
async function browserChannelLogin(
  connectionId: string,
  deadline: number,
  callbacks: DeviceFlowCallbacks,
  closePopup: () => void,
): Promise<CodeGPTCredentials> {
  let lastProgress = Date.now();

  for (;;) {
    if (callbacks.signal?.aborted) {
      closePopup();
      throw new Error('CodeGPT sign-in aborted');
    }

    if (Date.now() > deadline) {
      closePopup();
      throw new Error('CodeGPT sign-in timed out — please try again');
    }

    try {
      const credentials = await readLoginChannelOnce(connectionId, callbacks.signal);

      if (credentials) {
        closePopup();
        return credentials;
      }
    } catch (error) {
      if (callbacks.signal?.aborted) {
        closePopup();
        throw new Error('CodeGPT sign-in aborted');
      }

      /*
       * Channel setup failures are fatal (bad endpoint/proxy); anything else
       * (mid-stream "network error", dropped connection) is a dropped channel
       * and reconnects below.
       */
      if (error instanceof Error && /login channel failed/.test(error.message)) {
        closePopup();
        throw error;
      }
    }

    if (Date.now() - lastProgress > 10_000) {
      lastProgress = Date.now();
      callbacks.onProgress?.('Still waiting for CodeGPT sign-in — connection kept alive…');
    }

    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
  }
}

function credentialsFromSupervisor(payload: any): CodeGPTCredentials {
  const credentials: CodeGPTCredentials = {
    access: payload.credentials.access_token,
    refresh: payload.credentials.refresh_token ?? payload.credentials.access_token,
    expires: normalizeExpiry(payload.credentials.expires_at),
  };

  if (!isValidSessionTokenShape(credentials.access)) {
    throw new Error('CodeGPT login returned an unexpected token shape');
  }

  return credentials;
}

/**
 * Full browser device flow. Resolves with the credentials once CodeGPT's SSE
 * login channel pushes the tokens (the popup is closed by the caller's UI if
 * it is still open).
 *
 * Primary path: the Rust backend (`/api/codegpt-login-channel/:id`) holds the
 * SSE subscription to CodeGPT server-side and caches the token the moment it
 * is pushed; the browser only polls. This removes the browser-side race —
 * CodeGPT delivers the push once (fire-and-forget) to currently-connected
 * subscribers, and a browser reader cannot stay connected reliably (Chromium
 * kills long-lived idle fetch streams, and every reconnect gap would lose the
 * token — the login then hangs forever on "Still waiting…").
 *
 * Fallback: backends without the supervisor get the legacy in-browser SSE
 * read (auto-reconnecting, same connection id) until the deadline or an
 * abort.
 */
export async function loginCodeGPT(callbacks: DeviceFlowCallbacks = {}): Promise<CodeGPTCredentials> {
  const connectionId = crypto.randomUUID();

  /*
   * Identical to the official VSCode extension's login params. The connection
   * id ties the browser login to the SSE channel below; the session token is
   * then fetched from that channel by us (no redirect/callback needed).
   */
  const params = new URLSearchParams({
    source: 'vscode',
    distinct_id: 'codegpt-pi',
    connection_id: connectionId,
    flow_version: '1.1',
  });

  const loginUrl = `${CODEGPT_PLAYGROUND_URL}/login?${params.toString()}`;

  const popup = openLoginWindow(loginUrl);

  callbacks.onAuth?.({
    url: loginUrl,
    instructions: 'Sign in on the opened window (or open this URL on any device) and return here.',
  });
  callbacks.onProgress?.('Waiting for CodeGPT sign-in to complete…');

  const deadline = Date.now() + LOGIN_DEADLINE_MS;

  let lastProgress = Date.now();

  for (;;) {
    if (callbacks.signal?.aborted) {
      popup?.close();
      throw new Error('CodeGPT sign-in aborted');
    }

    if (Date.now() > deadline) {
      popup?.close();
      throw new Error('CodeGPT sign-in timed out — please try again');
    }

    try {
      const res = await fetch(`/api/codegpt-login-channel/${connectionId}`, {
        signal: callbacks.signal,
      });

      if (res.ok) {
        const data: any = await res.json();

        if (data?.status === 'ok' && typeof data.credentials?.access_token === 'string') {
          const credentials = credentialsFromSupervisor(data);

          popup?.close();

          return credentials;
        }
      } else if (res.status === 404 || res.status === 501) {
        /*
         * Backend predates the login-channel supervisor — direct browser
         * read.
         */
        return await browserChannelLogin(connectionId, deadline, callbacks, () => popup?.close());
      }
    } catch (error) {
      if (callbacks.signal?.aborted) {
        popup?.close();
        throw new Error('CodeGPT sign-in aborted');
      }

      /*
       * Fatal only when the token itself was malformed; transient poll
       * failures (proxy hiccup) just continue polling until the deadline.
       */
      if (error instanceof Error && /unexpected token shape/.test(error.message)) {
        popup?.close();
        throw error;
      }
    }

    if (Date.now() - lastProgress > 10_000) {
      lastProgress = Date.now();
      callbacks.onProgress?.('Still waiting for CodeGPT sign-in — connection kept alive…');
    }

    await new Promise((resolve) => setTimeout(resolve, SUPERVISOR_POLL_INTERVAL_MS));
  }
}

/**
 * CodeGPT session tokens do not expire (expires_at is year 9999), so refresh
 * is an identity operation. Kept for API symmetry with other providers.
 */
export async function refreshCodeGPTToken(credentials: CodeGPTCredentials): Promise<CodeGPTCredentials> {
  if (!credentials.access) {
    throw new Error('No CodeGPT session token; log in again.');
  }

  return credentials;
}
