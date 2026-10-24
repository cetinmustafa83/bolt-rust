//! Minimal `.env` file support: the server loads `.env.local` / `.env` from the
//! working directory so provider base-URL keys (OLLAMA_API_BASE_URL, …) behave
//! exactly like they did under the Cloudflare worker.

use std::collections::HashMap;
use std::path::Path;

pub fn load_env_files() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = HashMap::new();

    for candidate in [".env.local", ".env"] {
        let path = Path::new(candidate);

        if !path.exists() {
            continue;
        }

        let Ok(content) = std::fs::read_to_string(path) else {
            continue;
        };

        for line in content.lines() {
            let line = line.trim();

            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            let Some((key, value)) = line.split_once('=') else {
                continue;
            };

            let key = key.trim();
            let mut value = value.trim().to_string();

            // Strip a simple surrounding pair of quotes.
            if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
                || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
            {
                value = value[1..value.len() - 1].to_string();
            }

            // Later files override earlier ones, but blank values never
            // overwrite a value that was already set.
            if !value.is_empty() || !env.contains_key(key) {
                env.insert(key.to_string(), value);
            }
        }
    }

    // Real process environment always wins.
    for (key, value) in std::env::vars() {
        env.insert(key, value);
    }

    env
}
