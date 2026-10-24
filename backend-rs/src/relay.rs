//! `/api/llm-relay` — a generic streaming relay for provider endpoints that do
//! not send browser CORS headers (api.openai.com, api.codegpt.co, …).
//!
//! The browser/worker calls this endpoint instead of the provider directly;
//! the Rust server performs the upstream request server-side (no CORS
//! constraints) and streams the response back untouched.
//!
//! NOTE: this is intentionally a local sandbox relay. A production deployment
//! would restrict `x-relay-url` to an allowlist of provider hosts.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use std::sync::LazyLock;

/// Headers that must not be forwarded from the client call.
const HOP_BY_HOP: &[&str] = &["host", "connection", "content-length", "transfer-encoding", "accept-encoding"];

/// Headers worth forwarding to the upstream provider.
const FORWARD_HEADERS: &[&str] = &[
    "authorization",
    "content-type",
    "accept",
    "user-agent",
    "tokens",
    "channel",
    "source",
    "codegpt-org-id",
    "x-goog-api-key",
    "x-api-key",
    "api-key",
    "openai-organization",
    "openai-project",
    "http-referer",
    "x-title",
];

pub async fn relay(headers: HeaderMap, upstream_req: Request) -> Response {
    let Some(target) = headers
        .get("x-relay-url")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
    else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({ "error": "Missing x-relay-url header" })),
        )
            .into_response();
    };

    // Only http(s) absolute URLs are allowed.
    if !(target.starts_with("https://") || target.starts_with("http://")) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({ "error": "x-relay-url must be an absolute http(s) URL" })),
        )
            .into_response();
    }

    /*
     * Shared client: building a reqwest::Client per request would create a
     * fresh connection pool (and TLS session) for every relay call — socket
     * churn and file-descriptor pressure under load. One process-wide client
     * reuses its pool instead.
     */
    static RELAY_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .build()
            .expect("reqwest relay client")
    });
    let client = &*RELAY_CLIENT;

    let method =
        reqwest::Method::from_bytes(upstream_req.method().as_str().as_bytes()).unwrap_or(reqwest::Method::GET);

    let mut forwarded_headers = reqwest::header::HeaderMap::new();

    for (name, value) in headers.iter() {
        let lower = name.as_str().to_ascii_lowercase();

        if HOP_BY_HOP.contains(&lower.as_str()) || lower == "x-relay-url" {
            continue;
        }

        if !FORWARD_HEADERS.contains(&lower.as_str()) {
            continue;
        }

        if let (Ok(n), Ok(v)) = (
            reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            forwarded_headers.insert(n, v);
        }
    }

    let body_bytes = match axum::body::to_bytes(upstream_req.into_body(), 64 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({ "error": format!("failed to read body: {err}") })),
            )
                .into_response();
        }
    };

    let upstream = client
        .request(method, &target)
        .headers(forwarded_headers)
        .body(body_bytes.to_vec())
        .send()
        .await;

    let upstream = match upstream {
        Ok(resp) => resp,
        Err(err) => {
            tracing::warn!("relay to {target} failed: {err}");

            return (
                StatusCode::BAD_GATEWAY,
                axum::Json(serde_json::json!({ "error": format!("relay request failed: {err}") })),
            )
                .into_response();
        }
    };

    let status = upstream.status();
    let mut builder = Response::builder().status(StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY));

    for (name, value) in upstream.headers().iter() {
        let lower = name.as_str().to_ascii_lowercase();

        // Only forward safe, relevant response headers.
        if ["content-type", "cache-control", "x-request-id"].contains(&lower.as_str()) {
            builder = builder.header(name.clone(), value.clone());
        }
    }

    let stream = upstream.bytes_stream();
    let body = Body::from_stream(stream);

    builder.body(body).unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}
