import Cookies from 'js-cookie';

export const API_KEYS_UPDATED_EVENT = 'bolt:api-keys-updated';

export interface ApiKeysUpdatedDetail {
  apiKeys: Record<string, string>;
  providerName: string;
}

/**
 * Read the shared, cookie-backed provider key store (`apiKeys` cookie).
 * Lives here (not in a component) so non-component modules such as the
 * CodeGPT OAuth flow can read and update the same store.
 */
export function getApiKeysFromCookies(): Record<string, string> {
  const storedApiKeys = Cookies.get('apiKeys');

  let parsedKeys: Record<string, string> = {};

  if (storedApiKeys) {
    try {
      parsedKeys = JSON.parse(storedApiKeys);
    } catch {
      parsedKeys = {};
    }
  }

  return parsedKeys;
}
