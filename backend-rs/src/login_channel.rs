//! `/api/codegpt-login-channel/:id` — server-side supervisor for the CodeGPT
//! device-flow login channel.
//!
//! CodeGPT's login pushes the session token to its SSE channel
//! (`GET api.codegpt.co/api/v1/extensions/connection/:id`) as a **one-shot
//! pub/sub event: only subscribers connected at push time receive it** (the
//! official extensions hold exactly one continuous read for the whole login).
//! A browser-side reader cannot reproduce that reliably: Chromium tears down
//! long-lived idle fetch streams, and every reconnect opens a gap in which a
//! push is lost forever — the login then hangs on "Still waiting…".
//!
//! This endpoint moves the subscription server-side (stable tokio/reqwest
//! stream, no Chromium in the middle) and caches the token as soon as it
//! arrives. The browser simply polls:
//!
//!     { "status": "waiting" }
//!     { "status": "ok", "credentials": { "access_token": …, "refresh_token": …, "expires_at": … } }
//!
//! A supervisor is spawned on the first poll for a connection id and holds a
//! continuous, instantly-reconnecting read (the same EventSource-style
//! behavior as the official extension) until the token arrives, the browser
//! stops polling, or the overall deadline expires.

use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const CODEGPT_BACKEND: &str = "https://api.codegpt.co/api/v1";

/// Base URL override — same env contract as the official extension
/// (`CODEGPT_BACKEND_URL`), also useful for staging/test harnesses.
fn codegpt_backend() -> String {
    std::env::var("CODEGPT_BACKEND_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| CODEGPT_BACKEND.to_string())
}

/// How long a connection entry lives from creation (polls refresh nothing
/// except delivered credentials; entries vanish after this horizon).
const ENTRY_TTL: Duration = Duration::from_secs(30 * 60);
/// Overall lifetime of one supervisor (browser deadline is 5 min; be generous).
const SUPERVISOR_DEADLINE: Duration = Duration::from_secs(15 * 60);
/// If the browser has not polled for this long, stop the supervisor.
const POLL_IDLE_LIMIT: Duration = Duration::from_secs(3 * 60);
/// Reconnect delay after a channel ended without tokens (EventSource-style,
/// but near-instant — the push is fire-and-forget, gaps lose tokens).
const RECONNECT_IDLE: Duration = Duration::from_millis(400);
/// Reconnect delay after a failed/aborted connect (network down, non-200).
const RECONNECT_ERROR: Duration = Duration::from_millis(2000);
/// Hard cap for a single upstream read attempt (CodeGPT holds the stream).
const READ_ATTEMPT_CAP: Duration = Duration::from_secs(600);
/// Max silence between two chunks of one read attempt: CodeGPT sends
/// keep-alives every few seconds, so a longer stall means the connection is
/// effectively dead — abandon it instead of holding the task for the full
/// READ_ATTEMPT_CAP. Bounds supervisor exit after the browser leaves to
/// roughly this window.
const CHUNK_STALL_CAP: Duration = Duration::from_secs(90);
/// A token frame is tiny; a buffer growing past this without a newline means
/// the upstream is misbehaving — drop the attempt instead of growing memory.
const FRAME_BUFFER_CAP: usize = 256 * 1024;
/// How often the supervisor re-checks "should I still be alive?" inside a
/// running stream (keep-alives arrive more often than this, so the check is
/// effectively per keep-alive frame, throttled to avoid map-lock traffic).
const ALIVE_CHECK_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct Credentials {
    access: String,
    refresh: String,
    expires: Value,
}

struct ChannelEntry {
    credentials: Option<Credentials>,
    supervisor: Option<tokio::task::JoinHandle<()>>,
    created_at: Instant,
    last_poll: Instant,
}

static CHANNELS: LazyLock<Mutex<HashMap<String, ChannelEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Browser poll: ensure a supervisor runs for the id and report the result.
pub async fn poll(Path(id): Path<String>) -> Response {
    if id.len() < 8 || id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid connection id" })),
        )
            .into_response();
    }

    let now = Instant::now();
    let mut credentials: Option<Credentials> = None;

    {
        let mut map = match CHANNELS.lock() {
            Ok(map) => map,
            Err(poisoned) => poisoned.into_inner(),
        };

        // Lazy cleanup: forget expired entries, aborting their supervisors so
        // no detached task outlives its entry (dropping a JoinHandle merely
        // detaches the task — it would keep holding the upstream stream).
        retain_entries(&mut map, now);

        let entry = map.entry(id.clone()).or_insert_with(|| ChannelEntry {
            credentials: None,
            supervisor: None,
            created_at: now,
            last_poll: now,
        });

        entry.last_poll = now;

        if let Some(creds) = &entry.credentials {
            credentials = Some(creds.clone());
        } else {
            // (Re)spawn the supervisor when there is no live one.
            let needs_spawn = entry
                .supervisor
                .as_ref()
                .map(|handle| handle.is_finished())
                .unwrap_or(true);

            if needs_spawn {
                entry.supervisor = Some(tokio::spawn(supervise(id)));
            }
        }
    }

    match credentials {
        Some(creds) => Json(json!({
            "status": "ok",
            "credentials": {
                "access_token": creds.access,
                "refresh_token": creds.refresh,
                "expires_at": creds.expires,
            },
        }))
        .into_response(),
        None => Json(json!({ "status": "waiting" })).into_response(),
    }
}

fn credentials_stored(id: &str) -> bool {
    let map = match CHANNELS.lock() {
        Ok(map) => map,
        Err(poisoned) => poisoned.into_inner(),
    };

    map.get(id).is_some_and(|entry| entry.credentials.is_some())
}

/// Drop entries past their TTL or idle limit, aborting their supervisors.
fn retain_entries(map: &mut HashMap<String, ChannelEntry>, now: Instant) {
    map.retain(|_, entry| {
        let keep = now.duration_since(entry.created_at) < ENTRY_TTL
            && now.duration_since(entry.last_poll) < POLL_IDLE_LIMIT;

        if !keep {
            if let Some(handle) = entry.supervisor.take() {
                handle.abort();
            }
        }

        keep
    });
}

/// Should the supervisor for `id` stop holding the upstream channel?
/// True when the token was stored, the browser stopped polling, or the entry
/// was cleaned up (nobody is waiting anymore).
fn supervisor_should_stop(id: &str) -> bool {
    let map = match CHANNELS.lock() {
        Ok(map) => map,
        Err(poisoned) => poisoned.into_inner(),
    };

    match map.get(id) {
        Some(entry) => {
            if entry.credentials.is_some() {
                return true;
            }

            Instant::now().duration_since(entry.last_poll) > POLL_IDLE_LIMIT
        }
        None => true,
    }
}

/// Background sweep so entries (and their supervisors) expire even when no
/// further polls arrive to trigger the lazy cleanup — e.g. a login tab that
/// was closed before ever completing.
pub fn spawn_sweeper() {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(POLL_IDLE_LIMIT.min(ENTRY_TTL) / 3);

        loop {
            interval.tick().await;

            let now = Instant::now();
            let mut map = match CHANNELS.lock() {
                Ok(map) => map,
                Err(poisoned) => poisoned.into_inner(),
            };

            let before = map.len();
            retain_entries(&mut map, now);

            if map.len() != before {
                tracing::debug!("codegpt login channel sweeper: dropped {} stale entries", before - map.len());
            }
        }
    });
}

fn store_credentials(id: &str, credentials: Credentials) {
    let mut map = match CHANNELS.lock() {
        Ok(map) => map,
        Err(poisoned) => poisoned.into_inner(),
    };

    if let Some(entry) = map.get_mut(id) {
        if entry.credentials.is_none() {
            entry.credentials = Some(credentials);
        }
    }
}

/// Hold one continuous, instantly-reconnecting read of CodeGPT's login channel
/// for the connection id until the token is pushed, the browser stops polling,
/// or the deadline expires. Mirrors the official extension's single held read.
async fn supervise(id: String) {
    let deadline = Instant::now() + SUPERVISOR_DEADLINE;

    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            tracing::warn!("codegpt login channel {id}: client build failed: {err}");
            return;
        }
    };

    let url = format!("{}/extensions/connection/{}", codegpt_backend(), id);

    while Instant::now() < deadline {
        if supervisor_should_stop(&id) {
            if credentials_stored(&id) {
                return;
            }

            tracing::info!("codegpt login channel {id}: browser stopped polling, supervisor exiting");

            return;
        }

        let attempt = client
            .get(&url)
            .header("accept", "text/event-stream")
            .timeout(READ_ATTEMPT_CAP)
            .send()
            .await;

        let upstream = match attempt {
            Ok(resp) if resp.status().is_success() => resp,
            Ok(resp) => {
                tracing::debug!("codegpt login channel {id}: HTTP {}", resp.status());
                tokio::time::sleep(RECONNECT_ERROR).await;
                continue;
            }
            Err(err) => {
                tracing::debug!("codegpt login channel {id}: connect failed: {err}");
                tokio::time::sleep(RECONNECT_ERROR).await;
                continue;
            }
        };

        let mut stream = upstream.bytes_stream();
        let mut buffer: Vec<u8> = Vec::with_capacity(1024);
        let mut ended_without_tokens = false;
        let mut last_alive_check = Instant::now();

        loop {
            /*
             * Bounded wait for the next chunk: CodeGPT streams keep-alives
             * every few seconds, so a stall past CHUNK_STALL_CAP means the
             * connection is dead. Without this cap a silent upstream would
             * hold this task (and its socket) for the full READ_ATTEMPT_CAP.
             */
            let chunk = match tokio::time::timeout(CHUNK_STALL_CAP, stream.next()).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break, // upstream closed the stream
                Err(_elapsed) => {
                    tracing::debug!("codegpt login channel {id}: chunk stall cap hit");
                    ended_without_tokens = true;
                    break;
                }
            };

            match chunk {
                Ok(bytes) => {
                    /*
                     * Periodic liveness check while the stream runs: the
                     * token may already be stored (another path) or the
                     * browser may have left mid-login — stop holding the
                     * upstream connection promptly instead of waiting for
                     * the outer loop between attempts.
                     */
                    if last_alive_check.elapsed() >= ALIVE_CHECK_INTERVAL {
                        last_alive_check = Instant::now();

                        if supervisor_should_stop(&id) {
                            return;
                        }
                    }

                    buffer.extend_from_slice(&bytes);

                    if buffer.len() > FRAME_BUFFER_CAP {
                        tracing::warn!("codegpt login channel {id}: frame buffer cap exceeded, dropping attempt");
                        ended_without_tokens = true;
                        break;
                    }

                    while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buffer.drain(..=pos).collect();
                        let line = String::from_utf8_lossy(&line[..line.len().saturating_sub(1)]); // drop \n

                        let Some(payload) = line.strip_prefix("data:") else {
                            continue; // retry hint / keep-alive / comment frame
                        };

                        let payload = payload.trim();

                        if payload.is_empty() {
                            continue;
                        }

                        let Ok(frame) = serde_json::from_str::<Value>(payload) else {
                            continue; // keep-alive / comment frame
                        };

                        let Some(access) = frame.get("access_token").and_then(Value::as_str) else {
                            continue; // not the token push
                        };

                        if access.is_empty() {
                            continue;
                        }

                        let credentials = Credentials {
                            access: access.to_string(),
                            refresh: frame
                                .get("refresh_token")
                                .and_then(Value::as_str)
                                .unwrap_or(access)
                                .to_string(),
                            expires: frame
                                .get("expires_at")
                                .cloned()
                                .unwrap_or_else(|| json!(253402300799000u64)),
                        };

                        tracing::info!("codegpt login channel {id}: session token received");
                        store_credentials(&id, credentials);

                        return;
                    }
                }
                Err(err) => {
                    tracing::debug!("codegpt login channel {id}: stream error: {err}");
                    ended_without_tokens = true;
                    break;
                }
            }
        }

        if credentials_stored(&id) {
            return;
        }

        let _ = ended_without_tokens;

        // Channel ended (or read cap hit) without tokens — reconnect fast;
        // the push is fire-and-forget so the gap must stay minimal.
        tokio::time::sleep(RECONNECT_IDLE).await;
    }

    tracing::info!("codegpt login channel {id}: supervisor deadline reached");
}
