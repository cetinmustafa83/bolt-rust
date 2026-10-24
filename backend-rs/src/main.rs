//! bolt-server — the Rust backend for bolt.diy.
//!
//! Replaces the Cloudflare workerd/miniflare runtime:
//!
//! - serves the static SPA bundle (build/client) with an index.html fallback
//! - implements the light API surface the browser still needs:
//!     * GET  /api/health
//!     * GET  /api/check-env-key?provider=…
//!     * GET  /api/configured-providers
//!     * GET  /api/models?providers=A,B   (static catalog + dynamic fetches)
//!     * GET  /api/models/:provider
//!     * GET  /api/update                 (manual-update contract)
//!     * GET  /api/github-template?repo=… (starter-template file lists)
//!     * ANY  /api/llm-relay              (streaming CORS relay)
//!     * GET  /api/codegpt-login-channel/:id (server-held CodeGPT device-flow
//!       login channel + token cache; the browser polls, the push is one-shot)
//!     * GET  /webcontainer/connect/:id   (raw HTML document, as before)
//! - returns a clean 501 JSON for every other /api/* route so the UI degrades
//!   gracefully instead of receiving index.html from the SPA fallback.
//!
//! The heavy LLM orchestration does not run here: it lives in the browser's
//! Comlink chat worker (app/workers/chat.worker.ts).

mod catalog;
mod envfile;
mod github_template;
mod login_channel;
mod relay;

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tower::util::ServiceExt;

use catalog::{fetch_dynamic_models, load_catalog, ModelInfo, ProviderCatalogEntry};

const LOCAL_PROVIDERS: &[&str] = &["OpenAILike", "LMStudio", "Ollama"];

#[derive(Clone)]
struct AppState {
    client_dir: PathBuf,
    env: HashMap<String, String>,
    providers: Vec<ProviderCatalogEntry>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "bolt_server=info,tower_http=warn".into()),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(5173);
    let host: String = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into());

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let client_dir = cwd.join("build/client");

    if !client_dir.join("index.html").exists() {
        tracing::error!(
            "build/client/index.html not found under {} — run `pnpm run build` first",
            client_dir.display()
        );
        std::process::exit(1);
    }

    let env = envfile::load_env_files();
    let providers = load_catalog();

    // Periodic cleanup for CodeGPT login-channel entries/supervisors so they
    // expire even when no further browser polls trigger the lazy sweep.
    login_channel::spawn_sweeper();

    tracing::info!(
        "bolt-server starting: {} providers ({} dynamic), static dir {}",
        providers.len(),
        providers.iter().filter(|p| p.has_dynamic_models).count(),
        client_dir.display()
    );

    let state = AppState {
        client_dir,
        env,
        providers,
    };

    let api = Router::new()
        .route("/health", get(health))
        .route("/check-env-key", get(check_env_key))
        .route("/configured-providers", get(configured_providers))
        .route("/models", get(models_all))
        .route("/models/{provider}", get(models_one_provider))
        .route("/update", any(update))
        .route("/github-template", get(github_template::github_template))
        .route("/llm-relay", any(relay::relay))
        .route("/codegpt-login-channel/{id}", get(login_channel::poll))
        .fallback(api_fallback);

    let app = Router::new()
        .nest("/api", api)
        .route("/webcontainer/connect/{id}", get(webcontainer_connect))
        .fallback(static_handler)
        .layer(axum::middleware::from_fn(isolation_headers))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], port)));

    tracing::info!("listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind 0.0.0.0");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}

/// Cross-origin isolation middleware.
///
/// The workbench terminal (xterm bridge) and WebContainer tooling post
/// `SharedArrayBuffer` between threads, which requires the page to be
/// cross-origin isolated: COOP `same-origin` + COEP `credentialless`
/// (accepted by Chromium and Firefox; avoids breaking cross-origin fonts /
/// CDN modules that would fail under `require-corp` without CORP headers).
async fn isolation_headers(req: Request, next: axum::middleware::Next) -> Response {
    /*
     * Diagnostics / escape hatch: `?coep=none` on any document request opts
     * the page out of the isolation headers. This reproduces exactly what an
     * embedding context that cannot set COOP/COEP (preview panels, iframes)
     * sees, so the WebContainer `coep: 'none'` boot path can be tested from a
     * top-level window as well.
     */
    let skip_isolation = req
        .uri()
        .query()
        .map(|q| q.split('&').any(|pair| pair == "coep=none"))
        .unwrap_or(false);

    let mut res = next.run(req).await;

    if skip_isolation {
        return res;
    }

    let headers = res.headers_mut();

    headers.insert(
        header::HeaderName::from_static("cross-origin-opener-policy"),
        header::HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        header::HeaderName::from_static("cross-origin-embedder-policy"),
        header::HeaderValue::from_static("credentialless"),
    );

    res
}

// =============================================================================
// Cookie parsing (mirrors app/lib/api/cookies.ts, incl. percent decoding)
// =============================================================================

fn parse_cookies(cookie_header: &str) -> HashMap<String, String> {
    let mut cookies = HashMap::new();

    for item in cookie_header.split(';') {
        let item = item.trim();

        if item.is_empty() {
            continue;
        }

        let Some((name, value)) = item.split_once('=') else {
            continue;
        };

        let decoded_name = percent_decode_str(name.trim()).decode_utf8_lossy().to_string();
        let decoded_value = percent_decode_str(value.trim()).decode_utf8_lossy().to_string();

        cookies.insert(decoded_name, decoded_value);
    }

    cookies
}

fn api_keys_from_headers(headers: &HeaderMap) -> HashMap<String, String> {
    let cookie_header = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let cookies = parse_cookies(cookie_header);
    let raw = cookies.get("apiKeys").cloned().unwrap_or_default();

    serde_json::from_str::<HashMap<String, String>>(&raw).unwrap_or_default()
}

fn provider_settings_from_headers(headers: &HeaderMap) -> Value {
    let cookie_header = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let cookies = parse_cookies(cookie_header);
    let raw = cookies.get("providers").cloned().unwrap_or_default();

    serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({}))
}

fn placeholder_free(value: Option<&String>) -> bool {
    match value {
        Some(v) => {
            !v.trim().is_empty() && !v.contains("your_") && !v.contains("_here")
        }
        None => false,
    }
}

// =============================================================================
// API handlers
// =============================================================================

async fn health() -> Json<Value> {
    Json(json!({
        "status": "healthy",
        "timestamp": chrono_like_timestamp(),
    }))
}

/// RFC 3339 timestamp without pulling chrono: seconds-precision is enough here.
fn chrono_like_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Convert unix seconds to an ISO-8601 UTC string (no external crates).
    let days = now / 86_400;
    let secs_of_day = now % 86_400;
    let (h, m, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);

    // Civil-from-days algorithm (Howard Hinnant).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}.000Z")
}

async fn check_env_key(Query(params): Query<HashMap<String, String>>, State(state): State<AppState>) -> Json<Value> {
    let Some(provider) = params.get("provider") else {
        return Json(json!({ "isSet": false }));
    };

    let is_set = state
        .providers
        .iter()
        .find(|p| &p.name == provider)
        .map(|p| {
            let api_token_set = p
                .config
                .api_token_key
                .as_ref()
                .map(|k| placeholder_free(state.env.get(k)))
                .unwrap_or(false);
            let base_url_set = p
                .config
                .base_url_key
                .as_ref()
                .map(|k| placeholder_free(state.env.get(k)))
                .unwrap_or(false);

            api_token_set || base_url_set
        })
        .unwrap_or(false);

    Json(json!({ "isSet": is_set }))
}

async fn configured_providers(State(state): State<AppState>) -> Json<Value> {
    let providers: Vec<Value> = LOCAL_PROVIDERS
        .iter()
        .map(|name| {
            let entry = state.providers.iter().find(|p| p.name == *name);

            let is_configured = entry
                .map(|p| {
                    let base_url_ok = p
                        .config
                        .base_url_key
                        .as_ref()
                        .and_then(|k| state.env.get(k))
                        .map(|v| {
                            placeholder_free(Some(v))
                                && v.starts_with("http")
                        })
                        .unwrap_or(false);

                    let api_token_ok = p
                        .config
                        .api_token_key
                        .as_ref()
                        .and_then(|k| state.env.get(k))
                        .map(|v| placeholder_free(Some(v)) && v.len() > 10)
                        .unwrap_or(false);

                    base_url_ok || api_token_ok
                })
                .unwrap_or(false);

            json!({
                "name": name,
                "isConfigured": is_configured,
                "configMethod": if is_configured { "environment" } else { "none" },
            })
        })
        .collect();

    Json(json!({ "providers": providers }))
}

/// The `providers` + `defaultProvider` metadata block of the /api/models response.
fn provider_metadata(state: &AppState) -> (Vec<Value>, Value) {
    let mut providers: Vec<Value> = state
        .providers
        .iter()
        .map(|p| {
            json!({
                "name": p.name,
                "staticModels": p.static_models,
                "getApiKeyLink": p.get_api_key_link,
                "labelForGetApiKey": p.label_for_get_api_key,
                "icon": p.icon,
            })
        })
        .collect();

    // Stable ordering (original iterates a Map, i.e. registration order).
    providers.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));

    // Mirror the client's getDefaultProvider() preference order (see
    // app/lib/modules/llm/manager.ts): CodeGPT first (browser OAuth login +
    // dynamic catalog), then OpenRouter, then the first catalog entry.
    let default = providers
        .iter()
        .find(|p| p["name"] == "CodeGPT")
        .or_else(|| providers.iter().find(|p| p["name"] == "OpenRouter"))
        .cloned()
        .or_else(|| providers.first().cloned())
        .unwrap_or_else(|| json!({ "name": "OpenRouter", "staticModels": [] }));

    (providers, default)
}

/// Assemble the model list: static models for enabled providers + dynamic
/// models for the providers that support them (fetched in parallel), with the
/// same static/dynamic de-duplication and name ordering as LLMManager.
async fn assemble_model_list(
    state: AppState,
    headers: &HeaderMap,
    enabled_provider_names: Option<Vec<String>>,
) -> Vec<ModelInfo> {
    let api_keys = api_keys_from_headers(headers);
    let provider_settings = provider_settings_from_headers(headers);

    let selected: Vec<&ProviderCatalogEntry> = match &enabled_provider_names {
        Some(names) => {
            let name_set: HashSet<&String> = names.iter().collect();

            state
                .providers
                .iter()
                .filter(|p| name_set.contains(&p.name))
                .collect()
        }
        None => state.providers.iter().collect(),
    };

    // Dynamic fetches run concurrently, like Promise.all in the original.
    let dynamic_futures = selected.iter().map(|entry| {
        let entry = (*entry).clone();
        let provider_settings = provider_settings.clone();
        let env = state.env.clone();
        let api_keys = api_keys.clone();

        tokio::spawn(async move {
            fetch_dynamic_models(&entry, &provider_settings, &env, &api_keys).await
        })
    });

    let dynamic_results = futures_util::future::join_all(dynamic_futures).await;

    let mut dynamic_models: Vec<ModelInfo> = dynamic_results
        .into_iter()
        .filter_map(|r| r.ok())
        .flatten()
        .collect();

    let mut models: Vec<ModelInfo> = dynamic_models
        .drain(..)
        .chain(
            selected
                .iter()
                .flat_map(|entry| entry.static_model_infos()),
        )
        .collect();

    // De-duplicate (dynamic first wins, matching the original ordering rules).
    let mut seen: HashSet<String> = HashSet::new();
    models.retain(|m| seen.insert(format!("{}-{}", m.name, m.provider)));

    models.sort_by(|a, b| a.name.cmp(&b.name));

    models
}

#[derive(serde::Deserialize)]
struct ModelsQuery {
    #[serde(rename = "providers")]
    providers: Option<String>,
}

/// Short-lived browser cache for model lists: instant re-opens of the picker
/// hit the HTTP cache, while login/key changes still bust through quickly.
const MODELS_CACHE_CONTROL: &str = "public, max-age=15";

fn models_response(body: Value) -> Response {
    (
        [(header::CACHE_CONTROL, MODELS_CACHE_CONTROL)],
        Json(body),
    )
        .into_response()
}

async fn models_all(
    State(state): State<AppState>,
    Query(query): Query<ModelsQuery>,
    headers: HeaderMap,
) -> Response {
    let enabled: Option<Vec<String>> = query.providers.and_then(|p| {
        let names: Vec<String> = p.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect();

        if names.is_empty() {
            None
        } else {
            Some(names)
        }
    });

    let model_list = assemble_model_list(state.clone(), &headers, enabled).await;
    let (providers, default_provider) = provider_metadata(&state);

    models_response(json!({
        "modelList": model_list,
        "providers": providers,
        "defaultProvider": default_provider,
    }))
}

async fn models_one_provider(
    State(state): State<AppState>,
    Path(provider): Path<String>,
    headers: HeaderMap,
) -> Response {
    let model_list = assemble_model_list(state.clone(), &headers, Some(vec![provider])).await;
    let (providers, default_provider) = provider_metadata(&state);

    models_response(json!({
        "modelList": model_list,
        "providers": providers,
        "defaultProvider": default_provider,
    }))
}

async fn update() -> Response {
    // Same contract as the original POST-only route.
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "error": "Updates must be performed manually in a server environment",
            "instructions": [
                "1. Navigate to the project directory",
                "2. Run: git fetch upstream",
                "3. Run: git pull upstream main",
                "4. Run: pnpm install",
                "5. Run: pnpm run build",
            ],
        })),
    )
        .into_response()
}

/// The former server-rendered /webcontainer/connect/:id HTML document,
/// reproduced byte-for-byte in behavior.
async fn webcontainer_connect(Path(_id): Path<String>, Query(params): Query<HashMap<String, String>>) -> Html<String> {
    let editor_origin = params
        .get("editorOrigin")
        .cloned()
        .unwrap_or_else(|| "https://stackblitz.com".into());

    Html(format!(
        r#"
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Connect to WebContainer</title>
      </head>
      <body>
        <script type="module">
          (async () => {{
            const {{ setupConnect }} = await import('https://cdn.jsdelivr.net/npm/@webcontainer/api@latest/dist/connect.js');
            setupConnect({{
              editorOrigin: '{editor_origin}'
            }});
          }})();
        </script>
      </body>
    </html>
  "#
    ))
}

/// Any other /api/* route: the SPA cannot implement server logic, so answer
/// with a clean 501 instead of falling through to index.html.
async fn api_fallback() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "This API route is not available in the Rust backend.",
            "hint": "The LLM orchestration moved to the browser (Comlink chat worker). Health, models, configured-providers, check-env-key, update and llm-relay are implemented natively.",
        })),
    )
        .into_response()
}

// =============================================================================
// Static SPA serving
// =============================================================================

async fn static_handler(State(state): State<AppState>, request: Request) -> Response {
    let path = request.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    // Resolve inside the client dir (ServeDir already guards traversal, but
    // keep the explicit check for the direct file reads below).
    let file_path = state.client_dir.join(path);

    if file_path.is_file() {
        if let Ok(bytes) = tokio::fs::read(&file_path).await {
            let mime = mime_guess::from_path(&file_path).first_or_octet_stream().to_string();
            let cache_control = if path.starts_with("assets/") {
                // Hashed asset filenames: cache aggressively.
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };

            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CACHE_CONTROL, cache_control)
                .body(Body::from(bytes))
                .unwrap();
        }
    }

    // SPA fallback: any unknown non-API GET path renders the app shell.
    let index = ServeDir::new(&state.client_dir)
        .fallback(ServeFile::new(state.client_dir.join("index.html")));

    match index.oneshot(request).await {
        Ok(response) => response.map(Body::new),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("static serving error: {err}"),
        )
            .into_response(),
    }
}
