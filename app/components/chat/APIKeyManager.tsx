import Cookies from 'js-cookie';
import React, { useState, useEffect, useCallback } from 'react';
import { IconButton } from '~/components/ui/IconButton';
import { getApiKeysFromCookies } from '~/lib/api/apiKeys';
import {
  CODEGPT_AUTH_ERROR_EVENT,
  CODEGPT_PROVIDER_NAME,
  invalidateCodeGPTSession,
  isValidSessionTokenShape,
  markCodeGPTSessionValid,
  validateCodeGPTSession,
} from '~/lib/codegpt/client';
import { loginCodeGPT, storeCodeGPTCredentials } from '~/lib/codegpt/oauth';
import type { ProviderInfo } from '~/types/model';

interface APIKeyManagerProps {
  provider: ProviderInfo;
  apiKey: string;
  setApiKey: (key: string) => void;
  getApiKeyLink?: string;
  labelForGetApiKey?: string;
}

/*
 * CodeGPT connection states shown by the chatbox status pill:
 * - connected    green check  — NOT a login trigger, click does nothing
 * - checking     spinner      — the stored token is being verified
 * - disconnected amber warning exclamation — click signs in
 * - invalid      red error exclamation    — stored token rejected, click signs in again
 * - error        red error exclamation    — a login attempt or chat request failed, click retries
 */
type CodeGPTConnection = 'checking' | 'connected' | 'disconnected' | 'invalid' | 'error';

// cache which stores whether the provider's API key is set via environment variable
const providerEnvKeyStatusCache: Record<string, boolean> = {};

export { getApiKeysFromCookies };

// eslint-disable-next-line @typescript-eslint/naming-convention
export const APIKeyManager: React.FC<APIKeyManagerProps> = ({ provider, apiKey, setApiKey }) => {
  const isCodeGPT = provider?.name === CODEGPT_PROVIDER_NAME;
  const [isEditing, setIsEditing] = useState(false);
  const [tempKey, setTempKey] = useState(apiKey);
  const [isEnvKeySet, setIsEnvKeySet] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginStatus, setLoginStatus] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [connection, setConnection] = useState<CodeGPTConnection>(() => (apiKey ? 'checking' : 'disconnected'));
  const [connectionNote, setConnectionNote] = useState<string | null>(null);

  /*
   * CodeGPT signs in through its OAuth device flow (popup + SSE token push).
   * The resulting session token is stored exactly like a manually-entered key
   * so every downstream consumer (model loading, chat, enhancer) works
   * unchanged.
   */
  const handleCodeGPTLogin = useCallback(async () => {
    setIsLoggingIn(true);
    setLoginStatus('Waiting for CodeGPT sign-in…');

    try {
      const credentials = await loginCodeGPT({
        onAuth: ({ url }) => setAuthUrl(url),
        onProgress: (message) => setLoginStatus(message),
      });

      storeCodeGPTCredentials(credentials);
      markCodeGPTSessionValid(credentials.access);
      setTempKey(credentials.access);
      setApiKey(credentials.access);
      setConnectionNote(null);
      setLoginStatus(null);
      setIsEditing(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnection('error');
      setConnectionNote(`Login failed: ${message}`);
      setLoginStatus(`Login failed: ${message}`);
    } finally {
      setIsLoggingIn(false);
      setAuthUrl(null);
    }
  }, [setApiKey]);

  // Reset states and load saved key when provider changes
  useEffect(() => {
    // Load saved API key from cookies for this provider
    const savedKeys = getApiKeysFromCookies();
    const savedKey = savedKeys[provider.name] || '';

    setTempKey(savedKey);
    setApiKey(savedKey);
    setIsEditing(false);
  }, [provider.name]);

  /*
   * CodeGPT connection state machine. A stored token is verified against
   * CodeGPT's authenticated /user probe (401 = rejected) so the pill shows:
   * disconnected (no token) / connected (verified) / invalid (rejected).
   * Login failures and chat-time auth rejections override it with 'error'.
   */
  useEffect(() => {
    if (!isCodeGPT) {
      return undefined;
    }

    const token = apiKey.trim();

    if (!token) {
      setConnection('disconnected');
      setConnectionNote(null);

      return undefined;
    }

    if (!isValidSessionTokenShape(token)) {
      setConnection('invalid');
      setConnectionNote('Stored CodeGPT session token is malformed — sign in again.');

      return undefined;
    }

    setConnection('checking');

    const controller = new AbortController();

    validateCodeGPTSession(token, controller.signal)
      .then((ok) => {
        if (controller.signal.aborted) {
          return;
        }

        setConnection(ok ? 'connected' : 'invalid');
        setConnectionNote(ok ? null : 'CodeGPT rejected the stored session token — sign in again.');
      })
      .catch(() => {
        /* aborted — a newer token took over */
      });

    return () => controller.abort();
  }, [isCodeGPT, apiKey]);

  /*
   * A CodeGPT request failed authentication mid-chat (401 / unsigned) — the
   * pill turns into its red error state immediately.
   */
  useEffect(() => {
    if (!isCodeGPT) {
      return undefined;
    }

    const onAuthError = () => {
      setConnection('error');
      setConnectionNote('CodeGPT rejected the session token during a request — sign in again.');
    };

    window.addEventListener(CODEGPT_AUTH_ERROR_EVENT, onAuthError);

    return () => window.removeEventListener(CODEGPT_AUTH_ERROR_EVENT, onAuthError);
  }, [isCodeGPT]);

  const checkEnvApiKey = useCallback(async () => {
    // Check cache first
    if (providerEnvKeyStatusCache[provider.name] !== undefined) {
      setIsEnvKeySet(providerEnvKeyStatusCache[provider.name]);
      return;
    }

    try {
      const response = await fetch(`/api/check-env-key?provider=${encodeURIComponent(provider.name)}`);
      const data = await response.json();
      const isSet = (data as { isSet: boolean }).isSet;

      // Cache the result
      providerEnvKeyStatusCache[provider.name] = isSet;
      setIsEnvKeySet(isSet);
    } catch (error) {
      console.error('Failed to check environment API key:', error);
      setIsEnvKeySet(false);
    }
  }, [provider.name]);

  useEffect(() => {
    checkEnvApiKey();
  }, [checkEnvApiKey]);

  const handleSave = () => {
    // Save to parent state
    setApiKey(tempKey);

    // Save to cookies
    const currentKeys = getApiKeysFromCookies();
    const newKeys = { ...currentKeys, [provider.name]: tempKey };
    Cookies.set('apiKeys', JSON.stringify(newKeys));

    setIsEditing(false);
  };

  /*
   * Sign out clears the stored session token (the device-flow login can be
   * repeated at any time).
   */
  const handleCodeGPTSignOut = useCallback(() => {
    invalidateCodeGPTSession(apiKey);

    const currentKeys = getApiKeysFromCookies();
    const newKeys = { ...currentKeys };

    delete newKeys[CODEGPT_PROVIDER_NAME];
    Cookies.set('apiKeys', JSON.stringify(newKeys));
    setTempKey('');
    setApiKey('');
    setConnectionNote(null);
  }, [apiKey, setApiKey]);

  return (
    <div className="flex flex-wrap items-center justify-between py-3 px-1 gap-y-2">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {/*
           * CodeGPT authenticates through OAuth — the raw "<provider> API
           * Key:" label and the signed-out status line are intentionally not
           * rendered in the chatbox; the "Login with CodeGPT" button is the
           * single action that communicates the state.
           */}
          {!isCodeGPT && (
            <span className="text-sm font-medium text-bolt-elements-textSecondary">{provider?.name} API Key:</span>
          )}
          {!isEditing && !isCodeGPT && (
            <div className="flex items-center gap-2">
              {apiKey ? (
                <>
                  <div className="i-ph:check-circle-fill text-green-500 w-4 h-4" />
                  <span className="text-xs text-green-500">Set via UI</span>
                </>
              ) : isEnvKeySet ? (
                <>
                  <div className="i-ph:check-circle-fill text-green-500 w-4 h-4" />
                  <span className="text-xs text-green-500">Set via environment variable</span>
                </>
              ) : (
                <>
                  <div className="i-ph:x-circle-fill text-red-500 w-4 h-4" />
                  <span className="text-xs text-red-500">Not Set (Please set via UI or ENV_VAR)</span>
                </>
              )}
            </div>
          )}
          {/*
           * CodeGPT connection pill. Connected is a plain status — NOT a
           * login trigger (clicking must not start the OAuth flow again);
           * disconnected shows an amber warning exclamation and error shows
           * a red one. Sign out (on the right) is the only connected action.
           *
           * The clickable states use native buttons instead of IconButton:
           * IconButton's base theme utilities (text-bolt-elements-item-
           * contentDefault, bg-transparent) are emitted after the palette
           * utilities in the compiled CSS and would override the pill's
           * warning/error colors. A plain button keeps amber/red
           * deterministic.
           */}
          {!isEditing &&
            isCodeGPT &&
            (isLoggingIn ? (
              <div
                role="status"
                title="Waiting for the CodeGPT sign-in to complete…"
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-bolt-elements-prompt-background text-bolt-elements-textSecondary cursor-default select-none"
              >
                <div className="i-ph:spinner-gap animate-spin w-4 h-4 shrink-0" />
                <span className="text-xs whitespace-nowrap">Signing in…</span>
              </div>
            ) : connection === 'connected' ? (
              <div
                role="status"
                title="Connected to CodeGPT (OAuth session token stored)"
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-green-500/10 text-green-500 cursor-default select-none"
              >
                <div className="i-ph:check-circle-fill w-4 h-4 shrink-0" />
                <span className="text-xs whitespace-nowrap">Connected</span>
              </div>
            ) : connection === 'checking' ? (
              <div
                role="status"
                title="Verifying the stored CodeGPT session…"
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-bolt-elements-prompt-background text-bolt-elements-textSecondary cursor-default select-none"
              >
                <div className="i-ph:spinner-gap animate-spin w-4 h-4 shrink-0" />
                <span className="text-xs whitespace-nowrap">Checking…</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleCodeGPTLogin}
                title={
                  connectionNote ??
                  (connection === 'disconnected'
                    ? 'Not connected — click to sign in with CodeGPT (OAuth)'
                    : 'CodeGPT session error — click to sign in again')
                }
                className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-focus transition-colors ${
                  connection === 'disconnected'
                    ? 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-500'
                    : 'bg-red-500/10 hover:bg-red-500/20 text-red-500'
                }`}
              >
                <div className="i-ph:warning-fill w-4 h-4 shrink-0" />
                <span className="whitespace-nowrap">
                  {connection === 'disconnected' ? 'Not connected — Sign in' : 'Error — Sign in again'}
                </span>
              </button>
            ))}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {isEditing ? (
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={tempKey}
              placeholder="Enter API Key"
              onChange={(e) => setTempKey(e.target.value)}
              className="w-[300px] px-3 py-1.5 text-sm rounded border border-bolt-elements-borderColor 
                        bg-bolt-elements-prompt-background text-bolt-elements-textPrimary 
                        focus:outline-none focus:ring-2 focus:ring-bolt-elements-focus"
            />
            <IconButton
              onClick={handleSave}
              title="Save API Key"
              className="bg-green-500/10 hover:bg-green-500/20 text-green-500"
            >
              <div className="i-ph:check w-4 h-4" />
            </IconButton>
            <IconButton
              onClick={() => setIsEditing(false)}
              title="Cancel"
              className="bg-red-500/10 hover:bg-red-500/20 text-red-500"
            >
              <div className="i-ph:x w-4 h-4" />
            </IconButton>
          </div>
        ) : (
          <>
            {/*
             * The OAuth login trigger lives in the status pill on the left
             * (amber warning = sign in, red error = sign in again); while
             * connected the pill is a non-interactive check, so no login
             * button is rendered on this side at all. Sign out is a native
             * button for deterministic red styling (see the pill comment).
             */}
            {isCodeGPT && apiKey && (
              <button
                type="button"
                onClick={handleCodeGPTSignOut}
                title="Sign out (clears the stored session token)"
                className="flex items-center gap-2 px-2 py-1 rounded-md text-xs text-red-500 bg-red-500/10 hover:bg-red-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-focus transition-colors"
              >
                <span className="whitespace-nowrap">Sign out</span>
                <div className="i-ph:sign-out w-4 h-4" />
              </button>
            )}
            {/*
             * The pencil (manual key edit) button is OAuth-only for CodeGPT —
             * tokens come from the OAuth flow or a URL handoff, so there is
             * nothing to edit by hand here.
             */}
            {!isCodeGPT && (
              <IconButton
                onClick={() => setIsEditing(true)}
                title="Edit API Key"
                className="bg-blue-500/10 hover:bg-blue-500/20 text-blue-500"
              >
                <div className="i-ph:pencil-simple w-4 h-4" />
              </IconButton>
            )}
            {/*
             * CodeGPT already gets the primary OAuth "Login with CodeGPT"
             * button above — the generic getApiKeyLink button would only
             * duplicate it, so it is intentionally suppressed here.
             */}
            {provider?.getApiKeyLink && !apiKey && !isCodeGPT && (
              <IconButton
                onClick={() => window.open(provider?.getApiKeyLink)}
                title="Get API Key"
                className="bg-purple-500/10 hover:bg-purple-500/20 text-purple-500 flex items-center gap-2"
              >
                <span className="text-xs whitespace-nowrap">{provider?.labelForGetApiKey || 'Get API Key'}</span>
                <div className={`${provider?.icon || 'i-ph:key'} w-4 h-4`} />
              </IconButton>
            )}
          </>
        )}
      </div>
      {isCodeGPT && (loginStatus || connectionNote) && (
        <div className="w-full text-xs text-bolt-elements-textSecondary pb-2">
          {loginStatus || connectionNote}
          {isLoggingIn && authUrl && (
            <a
              href={authUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-2 text-green-500 underline underline-offset-2 hover:text-green-400"
            >
              Open the login page manually
            </a>
          )}
        </div>
      )}
    </div>
  );
};
