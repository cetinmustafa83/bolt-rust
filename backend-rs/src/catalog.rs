//! Embedded provider catalog (generated from the TypeScript provider registry
//! via `scripts/dump-provider-catalog.ts`) plus the dynamic-model fetchers.
//!
//! The JSON is the single source of truth for /api/models and
//! /api/configured-providers, so the Rust backend and the browser worker see
//! exactly the same provider set without a JavaScript runtime.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// How long a fetched CodeGPT catalog stays hot in memory. The catalog changes
/// rarely; the TTL keeps /api/models snappy (one upstream call per minute,
/// everything else served from RAM in microseconds) without serving stale
/// tiers after a provider update.
const CODEGPT_CATALOG_TTL: Duration = Duration::from_secs(60);

struct CatalogCacheEntry {
    models: Vec<ModelInfo>,
    fetched_at: Instant,
}

static CODEGPT_CATALOG_CACHE: Mutex<Option<CatalogCacheEntry>> = Mutex::new(None);

/// One model row as served to the UI (mirrors `ModelInfo` in app/lib/modules/llm/types.ts).
#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub name: String,
    pub label: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_free: Option<bool>,
    #[serde(rename = "maxTokenAllowed")]
    pub max_token_allowed: u64,
    #[serde(rename = "maxCompletionTokens", skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderCatalogEntry {
    pub name: String,
    #[serde(rename = "staticModels")]
    pub static_models: Vec<CatalogModel>,
    #[serde(rename = "getApiKeyLink", default)]
    pub get_api_key_link: Option<String>,
    #[serde(rename = "labelForGetApiKey", default)]
    pub label_for_get_api_key: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    pub config: ProviderConfig,
    #[serde(rename = "hasDynamicModels")]
    pub has_dynamic_models: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CatalogModel {
    pub name: String,
    pub label: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_free: Option<bool>,
    #[serde(rename = "maxTokenAllowed")]
    pub max_token_allowed: u64,
    #[serde(rename = "maxCompletionTokens", default, skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderConfig {
    #[serde(rename = "baseUrlKey", default)]
    pub base_url_key: Option<String>,
    #[serde(rename = "apiTokenKey", default)]
    pub api_token_key: Option<String>,
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
}

const CATALOG_JSON: &str = include_str!("../catalog.json");

/// True when neither the id nor the display name references Claude/Anthropic.
/// The project carries no Claude binding — CodeGPT / OpenRouter / Google /
/// OpenAI / … are the supported alternatives, so every catalog source
/// (the compiled static catalog and the dynamic CodeGPT upstream) is filtered
/// through this predicate. Mirrors the TS-side filter in
/// `app/lib/codegpt/client.ts#fetchCatalogModels`.
fn is_claude_free(name: &str, label: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let l = label.to_ascii_lowercase();

    !(n.contains("claude")
        || n.contains("anthropic")
        || l.contains("claude")
        || l.contains("anthropic"))
}

pub fn load_catalog() -> Vec<ProviderCatalogEntry> {
    let mut providers: Vec<ProviderCatalogEntry> = serde_json::from_str::<serde_json::Value>(CATALOG_JSON)
        .and_then(|v| serde_json::from_value(v["providers"].clone()))
        .expect("catalog.json must be valid");

    // Belt-and-braces: drop Claude/Anthropic entries from the static catalog
    // the same way the dynamic upstream is filtered in fetch_codegpt_upstream,
    // so a stale catalog.json can never resurface them at runtime.
    providers.retain(|p| is_claude_free(&p.name, ""));

    for provider in &mut providers {
        provider
            .static_models
            .retain(|m| is_claude_free(&m.name, &m.label));
    }

    providers
}

impl ProviderCatalogEntry {
    /// The static models, re-serialized in the exact wire shape the UI expects.
    pub fn static_model_infos(&self) -> Vec<ModelInfo> {
        self.static_models
            .iter()
            .map(|m| ModelInfo {
                name: m.name.clone(),
                label: m.label.clone(),
                provider: m.provider.clone(),
                is_free: m.is_free,
                max_token_allowed: m.max_token_allowed,
                max_completion_tokens: m.max_completion_tokens,
            })
            .collect()
    }
}

/// Flat settings resolved from (in order): client cookies, environment file.
pub struct ResolvedConfig {
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

/// Resolve base URL / API key for a provider the same way
/// `BaseProvider.getProviderBaseUrlAndKey` does:
/// settings > serverEnv(key) > config.baseUrl.
pub fn resolve_config(
    entry: &ProviderCatalogEntry,
    provider_settings: Option<&Value>,
    env: &HashMap<String, String>,
    api_keys: &HashMap<String, String>,
) -> ResolvedConfig {
    let settings = provider_settings.and_then(|p| p.get(&entry.name));

    let base_url = {
        let from_settings = settings
            .and_then(|s| s.get("baseUrl"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty());

        from_settings
            .map(|s| s.to_string())
            .or_else(|| {
                entry
                    .config
                    .base_url_key
                    .as_ref()
                    .and_then(|k| env.get(k))
                    .filter(|v| !v.trim().is_empty() && !v.contains("your_") && !v.contains("_here"))
                    .cloned()
            })
            .or_else(|| entry.config.base_url.clone())
            .map(|u| u.trim_end_matches('/').to_string())
    };

    let api_key = api_keys
        .get(&entry.name)
        .filter(|k| !k.trim().is_empty())
        .cloned()
        .or_else(|| {
            entry
                .config
                .api_token_key
                .as_ref()
                .and_then(|k| env.get(k))
                .filter(|v| !v.trim().is_empty() && !v.contains("your_") && !v.contains("_here"))
                .cloned()
        });

    ResolvedConfig { base_url, api_key }
}

const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/*
 * Shared client: a fresh reqwest::Client per dynamic-model fetch would spin
 * up a new connection pool each time; one process-wide client reuses its
 * pool and keeps the file-descriptor footprint flat.
 */
static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .expect("reqwest client")
});

fn http_client() -> &'static reqwest::Client {
    &HTTP_CLIENT
}

/// Fetch dynamic models for one provider, mirroring the TypeScript
/// `getDynamicModels` implementations. Failures yield an empty list (the
/// original pipeline logs and continues as well).
pub async fn fetch_dynamic_models(
    entry: &ProviderCatalogEntry,
    provider_settings: &Value,
    env: &HashMap<String, String>,
    api_keys: &HashMap<String, String>,
) -> Vec<ModelInfo> {
    if !entry.has_dynamic_models {
        return vec![];
    }

    let cfg = resolve_config(entry, Some(provider_settings), env, api_keys);
    let client = http_client();

    match entry.name.as_str() {
        "Ollama" => fetch_ollama(client, cfg.base_url.as_deref()).await,
        "LMStudio" => fetch_lmstudio(client, cfg.base_url.as_deref()).await,
        "OpenAILike" => {
            fetch_openai_like(client, cfg.base_url.as_deref(), cfg.api_key.as_deref(), env).await
        }
        "CodeGPT" => fetch_codegpt(client).await,
        _ => vec![], // unknown dynamic provider: keep catalog-driven behaviour
    }
}

async fn fetch_ollama(client: &reqwest::Client, base_url: Option<&str>) -> Vec<ModelInfo> {
    let Some(base) = base_url else {
        return vec![];
    };

    let Ok(resp) = client.get(format!("{base}/api/tags")).send().await else {
        tracing::debug!("Ollama not reachable at {base} — is Ollama running?");
        return vec![];
    };

    let Ok(json) = resp.json::<Value>().await else {
        return vec![];
    };

    let Some(models) = json["models"].as_array() else {
        return vec![];
    };

    models
        .iter()
        .filter_map(|m| {
            let name = m["name"].as_str()?;
            let parameter_size = m["details"]["parameter_size"].as_str().unwrap_or("");
            let label = if parameter_size.is_empty() {
                name.to_string()
            } else {
                format!("{name} ({parameter_size})")
            };

            Some(ModelInfo {
                name: name.to_string(),
                label,
                provider: "Ollama".into(),
                is_free: Some(true),
                max_token_allowed: 128_000,
                max_completion_tokens: None,
            })
        })
        .collect()
}

async fn fetch_lmstudio(client: &reqwest::Client, base_url: Option<&str>) -> Vec<ModelInfo> {
    let Some(base) = base_url else {
        return vec![];
    };

    let Ok(resp) = client.get(format!("{base}/v1/models")).send().await else {
        tracing::debug!("LMStudio not reachable at {base} — is LM Studio running?");
        return vec![];
    };

    let Ok(json) = resp.json::<Value>().await else {
        return vec![];
    };

    let Some(data) = json["data"].as_array() else {
        return vec![];
    };

    data.iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?;

            Some(ModelInfo {
                name: id.to_string(),
                label: id.to_string(),
                provider: "LMStudio".into(),
                is_free: Some(true),
                max_token_allowed: 128_000,
                max_completion_tokens: None,
            })
        })
        .collect()
}

async fn fetch_openai_like(
    client: &reqwest::Client,
    base_url: Option<&str>,
    api_key: Option<&str>,
    env: &HashMap<String, String>,
) -> Vec<ModelInfo> {
    let (Some(base), Some(key)) = (base_url, api_key) else {
        return vec![];
    };

    let result = client
        .get(format!("{base}/models"))
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await;

    match result {
        Ok(resp) => {
            let Ok(json) = resp.json::<Value>().await else {
                return vec![];
            };

            let Some(data) = json["data"].as_array() else {
                return vec![];
            };

            data.iter()
                .filter_map(|m| {
                    let id = m["id"].as_str()?;

                    Some(ModelInfo {
                        name: id.to_string(),
                        label: id.to_string(),
                        provider: "OpenAILike".into(),
                        is_free: None,
                        max_token_allowed: 128_000,
                        max_completion_tokens: None,
                    })
                })
                .collect()
        }
        Err(_) => {
            // Fallback env list (mirrors the OpenAILike provider behaviour).
            let models_env = env.get("OPENAI_LIKE_API_MODELS").cloned().unwrap_or_default();

            models_env
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|name| ModelInfo {
                    name: name.to_string(),
                    label: name.to_string(),
                    provider: "OpenAILike".into(),
                    is_free: None,
                    max_token_allowed: 128_000,
                    max_completion_tokens: None,
                })
                .collect()
        }
    }
}

/// Fetch the CodeGPT model catalog through a 60s in-memory TTL cache. Stale
/// entries are replaced in the background-free way: on expiry the next request
/// refetches, and a failed refetch falls back to the last good list (the
/// show must go on — an unavailable upstream must not empty the model picker).
async fn fetch_codegpt(client: &reqwest::Client) -> Vec<ModelInfo> {
    if let Ok(guard) = CODEGPT_CATALOG_CACHE.lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.fetched_at.elapsed() < CODEGPT_CATALOG_TTL {
                return entry.models.clone();
            }
        }
    }

    let fresh = fetch_codegpt_upstream(client).await;

    let models = if fresh.is_empty() {
        // Upstream hiccup: serve the last good catalog if we have one.
        if let Ok(guard) = CODEGPT_CATALOG_CACHE.lock() {
            if let Some(entry) = guard.as_ref() {
                return entry.models.clone();
            }
        }

        fresh
    } else {
        if let Ok(mut guard) = CODEGPT_CATALOG_CACHE.lock() {
            *guard = Some(CatalogCacheEntry {
                models: fresh.clone(),
                fetched_at: Instant::now(),
            });
        }

        fresh
    };

    models
}

async fn fetch_codegpt_upstream(client: &reqwest::Client) -> Vec<ModelInfo> {
    const BACKEND: &str = "https://api.codegpt.co/api/v1";

    let Ok(resp) = client
        .get(format!("{BACKEND}/vscode/catalog"))
        .timeout(Duration::from_secs(8))
        .send()
        .await
    else {
        tracing::debug!("CodeGPT catalog unreachable");
        return vec![];
    };

    let Ok(feed) = resp.json::<Value>().await else {
        return vec![];
    };

    let Some(menu) = feed["creditsMenu"].as_array() else {
        return vec![];
    };

    menu.iter()
        .filter(|entry| {
            /*
             * Deployment policy: this build ships without any Anthropic/Claude
             * tie. If CodeGPT's shared catalog offers such models, keep them
             * out of our picker.
             */
            let id = entry["id"].as_str().unwrap_or("").to_ascii_lowercase();
            let display = entry["name"].as_str().unwrap_or("").to_ascii_lowercase();

            !(id.contains("claude") || id.contains("anthropic") || display.contains("claude") || display.contains("anthropic"))
        })
        .filter_map(|entry| {
            let id = entry["id"].as_str()?;

            if id.is_empty() {
                return None;
            }

            let identity = feed["aliases"][id]
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| id.to_string());
            let fact = &feed["models"][&identity];
            let fact_fallback = &feed["models"][id];
            let context_window = fact["contextWindow"]
                .as_u64()
                .or(fact_fallback["contextWindow"].as_u64())
                .unwrap_or(128_000);

            /*
             * A completion budget can never exceed the context window; clamp
             * so downstream request builders (maxOutputTokens) stay valid.
             */
            let max_output = fact["maxOutput"]
                .as_u64()
                .or(fact_fallback["maxOutput"].as_u64())
                .unwrap_or(32_000)
                .min(context_window);

            let badge = entry["badge"].as_str().unwrap_or("").to_lowercase();
            let tier = match badge.as_str() {
                "free" => "free",
                "economy" => "economy",
                _ => {
                    if entry["pro"].as_bool().unwrap_or(false) {
                        "premium"
                    } else {
                        "economy"
                    }
                }
            };

            let display = entry["name"].as_str().filter(|s| !s.is_empty()).unwrap_or(id);

            Some(ModelInfo {
                // Tier lives in the id exactly like the TypeScript port; the
                // browser's codegptFetch strips it again before the wire.
                name: format!("{id}/{tier}"),
                label: format!(
                    "{display} ({}, {} context)",
                    capitalize(tier),
                    format_context_size(context_window)
                ),
                provider: "CodeGPT".into(),
                is_free: Some(tier == "free"),
                max_token_allowed: context_window,
                max_completion_tokens: Some(max_output),
            })
        })
        .collect()
}

/// Compact, picker-friendly context size: 1048576 -> "1.0M", 512000 -> "512K",
/// 200000 -> "200K". Mirrors formatContextSize in ModelSelector.tsx so the
/// label and the picker badge never disagree.
fn format_context_size(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        return format!("{:.1}M", tokens as f64 / 1_000_000.0);
    }

    if tokens >= 1_000 {
        return format!("{}K", tokens / 1_000);
    }

    tokens.to_string()
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();

    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}
