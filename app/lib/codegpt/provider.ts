import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { CODEGPT_BACKEND_URL, CODEGPT_PROVIDER_NAME, codegptFetch, fetchCatalogModels } from './client';
import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';

/**
 * CodeGPT provider for bolt.diy.
 *
 * Ported from the `codegpt-pi` extension:
 * - OAuth device flow sign-in (`app/lib/codegpt/oauth.ts`) stores the session
 *   token in the shared apiKeys cookie under `CodeGPT`; a token can also be
 *   supplied through the URL (`app/lib/codegpt/url-auth.ts`).
 * - Models are always fetched dynamically from CodeGPT's public catalog
 *   (`/vscode/catalog`) — there is no static model list.
 * - The AI SDK's OpenAI-compatible stream is transparently translated to
 *   CodeGPT's `/chat/tools` route by `codegptFetch`.
 */
export default class CodeGPTProvider extends BaseProvider {
  name = CODEGPT_PROVIDER_NAME;

  /*
   * No getApiKeyLink/labelForGetApiKey: authentication is the OAuth device
   * flow ("Login with CodeGPT" button rendered by APIKeyManager and the cloud
   * providers tab). Advertising a generic "get API key" link only produced
   * duplicate sign-in buttons in the chatbox.
   */

  config = {
    baseUrlKey: 'CODEGPT_BACKEND_URL',
    apiTokenKey: 'CODEGPT_SESSION_TOKEN',
    baseUrl: CODEGPT_BACKEND_URL,
  };

  staticModels: ModelInfo[] = [];

  async getDynamicModels(
    _apiKeys?: Record<string, string>,
    _settings?: IProviderSetting,
    _serverEnv?: Record<string, string>,
  ): Promise<ModelInfo[]> {
    /*
     * The catalog endpoint is public — list CodeGPT models even before
     * sign-in so the worker-side model resolution matches the Rust
     * /api/models/CodeGPT endpoint (same rows, same labels). Signing in only
     * unlocks inference, never the catalog; an unsigned chat attempt is
     * stopped by getModelInstance with an actionable sign-in message.
     */
    try {
      return await fetchCatalogModels();
    } catch (error) {
      console.error(`Failed to fetch dynamic models for ${this.name}:`, error);

      return [];
    }
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModel {
    const { model, serverEnv, apiKeys, providerSettings } = options;

    const { baseUrl, apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv: serverEnv as any,
      defaultBaseUrlKey: 'CODEGPT_BACKEND_URL',
      defaultApiTokenKey: 'CODEGPT_SESSION_TOKEN',
    });

    if (!apiKey) {
      throw new Error(`Missing CodeGPT session token. Sign in via OAuth or set CODEGPT_SESSION_TOKEN.`);
    }

    const codegptClient = createOpenAI({
      baseURL: baseUrl,
      apiKey,

      /*
       * Translate the AI SDK's OpenAI wire format into CodeGPT's /chat/tools
       * contract (agentId, bare tools, synthesized usage, readable refusals).
       */
      fetch: codegptFetch,
    });

    return codegptClient.chat(model);
  }
}
