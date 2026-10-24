//! `/api/github-template` — starter-template file fetching for the SPA.
//!
//! Mirrors the original React Router server route's branch-archive path
//! (codeload.github.com), which needs no token and has no API rate limit.
//! Response shape is identical to the TypeScript route so
//! `app/utils/selectStarterTemplate.ts` keeps working unchanged:
//!
//! ```json
//! [{ "name": "package.json", "path": "package.json", "content": "..." }]
//! ```
//!
//! Binary files (NUL byte / invalid UTF-8) are skipped — starter templates
//! are injected through text-based boltAction tags, so binary assets cannot
//! be represented in this format.

use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;

/// Safety caps so a pathological repo cannot produce a giant response.
const MAX_FILE_BYTES: usize = 1_000_000;
const MAX_FILES: usize = 4000;

pub async fn github_template(Query(params): Query<HashMap<String, String>>) -> Response {
    let Some(repo) = params.get("repo").map(|s| s.trim().to_string()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Repository name is required" })),
        )
            .into_response();
    };

    if !is_valid_repo(&repo) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid repository name" })),
        )
            .into_response();
    }

    match fetch_repo_files(&repo).await {
        Ok(files) => Json(Value::Array(files)).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Failed to fetch template files", "details": err })),
        )
            .into_response(),
    }
}

/// Accepts plain `owner/repo` slugs only (defence against path traversal and
/// URL injection into the codeload host).
fn is_valid_repo(repo: &str) -> bool {
    let parts: Vec<&str> = repo.split('/').collect();

    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 100
                && !part.starts_with('.')
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
}

async fn fetch_repo_files(repo: &str) -> Result<Vec<Value>, String> {
    let client = reqwest::Client::builder()
        .user_agent("bolt.diy-app")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last_err = String::new();

    for branch in ["main", "master"] {
        let url = format!("https://codeload.github.com/{repo}/zip/refs/heads/{branch}");

        let resp = match client.get(&url).send().await {
            Ok(resp) => resp,
            Err(err) => {
                last_err = err.to_string();
                continue;
            }
        };

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            last_err = format!("No {branch} branch archive found for {repo}");
            continue;
        }

        if !resp.status().is_success() {
            last_err = format!("Failed to fetch {branch} branch archive: {}", resp.status());
            continue;
        }

        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

        return extract_text_files(&bytes, branch, repo);
    }

    Err(last_err)
}

fn extract_text_files(zip_bytes: &[u8], branch: &str, repo: &str) -> Result<Vec<Value>, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map_err(|err| format!("Invalid zip archive from {repo}#{branch}: {err}"))?;

    // The archive wraps everything in a root folder like "repo-main/".
    let mut root_prefix = String::new();

    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_string();

            if name.contains('/') {
                root_prefix = name.split('/').next().unwrap_or("").to_string();
                break;
            }
        }
    }

    let prefix = if root_prefix.is_empty() {
        String::new()
    } else {
        format!("{root_prefix}/")
    };

    let mut files = Vec::new();

    for i in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(i) else {
            continue;
        };

        if entry.is_dir() {
            continue;
        }

        let raw_name = entry.name().to_string();
        let path = if !prefix.is_empty() && raw_name.starts_with(&prefix) {
            raw_name[prefix.len()..].to_string()
        } else {
            raw_name.clone()
        };

        if path.is_empty() || path == ".git" || path.starts_with(".git/") {
            continue;
        }

        if files.len() >= MAX_FILES {
            break;
        }

        if entry.size() as usize > MAX_FILE_BYTES {
            continue;
        }

        let mut buf = Vec::with_capacity(entry.size() as usize);

        if entry.read_to_end(&mut buf).is_err() {
            continue;
        }

        // Binary content cannot be represented in text boltAction tags.
        if buf.contains(&0) {
            continue;
        }

        let Ok(content) = String::from_utf8(buf) else {
            continue;
        };

        let name = path.rsplit('/').next().unwrap_or("").to_string();

        files.push(json!({ "name": name, "path": path, "content": content }));
    }

    Ok(files)
}
