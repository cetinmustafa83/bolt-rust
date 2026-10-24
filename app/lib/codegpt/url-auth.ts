/**
 * URL-based session token capture for CodeGPT.
 *
 * Headless / cross-device flows: a login completed elsewhere can hand the
 * session token to this app through the URL
 * (`?codegpt_session_token=<jwt>` — aliases: `?session_token=`, `?token=`,
 * or `#codegpt_session_token=` in the hash). The token is stored in the same
 * cookie-backed key store the UI uses, the app is notified so the model
 * selector refreshes, and the parameter is scrubbed from the address bar so
 * it does not leak via history or screen sharing.
 */

import Cookies from 'js-cookie';

import { CODEGPT_PROVIDER_NAME, isValidSessionTokenShape } from './client';
import { API_KEYS_UPDATED_EVENT, type ApiKeysUpdatedDetail, getApiKeysFromCookies } from '~/lib/api/apiKeys';

const QUERY_ALIASES = ['codegpt_session_token', 'session_token', 'codegpt_token'] as const;
const HASH_PREFIX = '#codegpt_session_token=';

/**
 * Look for a CodeGPT session token in `location.search` / `location.hash`.
 * Returns the scrubbed URL to install via history.replaceState, or null when
 * no token parameter was present.
 */
function extractTokenFromUrl(): { token: string; cleanedUrl: string } | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const url = new URL(window.location.href);

  let token: string | null = null;

  for (const alias of QUERY_ALIASES) {
    const value = url.searchParams.get(alias);

    if (value) {
      token = value;
      url.searchParams.delete(alias);
      break;
    }
  }

  if (!token && window.location.hash.startsWith(HASH_PREFIX)) {
    token = window.location.hash.slice(HASH_PREFIX.length);
    url.hash = '';
  }

  if (!token) {
    return null;
  }

  return { token: token.trim(), cleanedUrl: url.toString() };
}

/**
 * Scan the current URL for a CodeGPT session token and store it. Safe to call
 * on every app start; a no-op without the parameter.
 */
export function captureCodeGPTSessionTokenFromUrl(): boolean {
  const extracted = extractTokenFromUrl();

  if (!extracted) {
    return false;
  }

  const { token, cleanedUrl } = extracted;

  if (isValidSessionTokenShape(token)) {
    const currentKeys = getApiKeysFromCookies();
    const newKeys = { ...currentKeys, [CODEGPT_PROVIDER_NAME]: token };

    Cookies.set('apiKeys', JSON.stringify(newKeys), { expires: 365, sameSite: 'lax' });
    window.dispatchEvent(
      new CustomEvent<ApiKeysUpdatedDetail>(API_KEYS_UPDATED_EVENT, {
        detail: { apiKeys: newKeys, providerName: CODEGPT_PROVIDER_NAME },
      }),
    );
    console.info(`[codegpt] session token captured from URL for ${CODEGPT_PROVIDER_NAME}`);
  } else {
    console.warn('[codegpt] ignoring malformed session token found in URL');
  }

  // Always scrub the parameter, valid or not.
  window.history.replaceState(window.history.state, '', cleanedUrl);

  return true;
}
