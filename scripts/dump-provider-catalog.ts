/**
 * Dumps the full provider catalog (static models + provider metadata) that the
 * LLMManager registry knows about into backend-rs/catalog.json.
 *
 * The Rust backend embeds this file (include_str!) to serve /api/models and
 * /api/configured-providers without needing a JavaScript runtime.
 *
 * Run: bun run scripts/dump-provider-catalog.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LLMManager } from '~/lib/modules/llm/manager';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const llmManager = LLMManager.getInstance({});

const catalog = llmManager.getAllProviders().map((provider) => ({
  name: provider.name,
  staticModels: provider.staticModels,
  getApiKeyLink: provider.getApiKeyLink ?? null,
  labelForGetApiKey: provider.labelForGetApiKey ?? null,
  icon: provider.icon ?? null,
  config: {
    baseUrlKey: provider.config.baseUrlKey ?? null,
    apiTokenKey: provider.config.apiTokenKey ?? null,
    baseUrl: provider.config.baseUrl ?? null,
  },
  hasDynamicModels: typeof provider.getDynamicModels === 'function',
}));

const outPath = resolve(root, 'backend-rs/catalog.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ providers: catalog }, null, 2));

console.log(`Wrote ${catalog.length} providers to ${outPath}`);
