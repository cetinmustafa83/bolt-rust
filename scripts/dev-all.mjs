#!/usr/bin/env node
/**
 * Dev orchestrator — `pnpm dev` runs BOTH halves of the Rust edition:
 *
 *   1. Rust backend (bolt-server) on DEV_RUST_PORT (default 5175)
 *      - built first with `cargo build --release` (incremental: fast after
 *        the first run; SKIP_RUST_BUILD=1 skips it entirely)
 *   2. Vite/React-Router dev server on DEV_UI_PORT (default 5173)
 *      - vite.config.ts proxies /api/* and /webcontainer/* to the Rust port,
 *        so the browser sees exactly the production API surface
 *
 * Degrades gracefully: without Rust installed (or without a successful
 * build) it still starts the UI-only dev server — the app then relies on
 * its client-side fallbacks (e.g. in-browser CodeGPT SSE channel).
 *
 * Ports are overridable so several stacks can run side by side:
 *   DEV_UI_PORT=5183 DEV_RUST_PORT=5176 pnpm dev
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const RUST_PORT = process.env.DEV_RUST_PORT ?? '5175';
const UI_PORT = process.env.DEV_UI_PORT ?? '5173';
const serverBin = path.join(root, 'backend-rs', 'target', 'release', isWin ? 'bolt-server.exe' : 'bolt-server');

const children = [];
let shuttingDown = false;

function tagStream(stream, label) {
  stream.setEncoding('utf8');
  let buffer = '';

  stream.on('data', (chunk) => {
    buffer += chunk;
    let index;

    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);

      if (line.length > 0) {
        console.log(`[${label}] ${line}`);
      }
    }
  });

  stream.on('end', () => {
    if (buffer.trim().length > 0) {
      console.log(`[${label}] ${buffer.trim()}`);
    }
  });
}

function tag(child, label) {
  if (child.stdout) {
    tagStream(child.stdout, label);
  }

  if (child.stderr) {
    tagStream(child.stderr, label);
  }
}

function shutdown(code) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    try {
      if (!child.killed && child.exitCode === null) {
        child.kill(isWin ? undefined : 'SIGTERM');
      }
    } catch {
      /* already gone */
    }
  }

  process.exitCode = code ?? 0;
  setTimeout(() => process.exit(code ?? 0), 300).unref?.();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 0) banner + app/commit.json (same contract as the old `dev` script).
spawnSync('node', ['pre-start.cjs'], { cwd: root, stdio: 'inherit', shell: isWin });

// 1) Build the Rust backend (incremental; first run takes a minute or two).
const cargoCheck = spawnSync('cargo', ['--version'], { shell: isWin, encoding: 'utf8' });

if (cargoCheck.status !== 0) {
  console.warn('[dev] cargo not found on PATH — starting UI-only dev (client-side API fallbacks active).');
  console.warn('[dev] Install Rust (https://rustup.rs) and re-run `pnpm dev` for the full stack.');
} else if (process.env.SKIP_RUST_BUILD !== '1') {
  console.log('[dev] cargo build --release (backend-rs) …');
  const build = spawnSync('cargo', ['build', '--release'], {
    cwd: path.join(root, 'backend-rs'),
    stdio: 'inherit',
    shell: isWin,
  });

  if (build.status !== 0) {
    console.warn('[dev] cargo build failed — starting UI-only dev.');
  }
}

// 2) Rust server.
if (existsSync(serverBin)) {
  const rust = spawn(serverBin, [], {
    cwd: root,
    env: { ...process.env, PORT: RUST_PORT, RUST_LOG: process.env.RUST_LOG ?? 'info' },
  });
  children.push(rust);
  tag(rust, 'rust');
  rust.on('exit', (code) => console.warn(`[dev] bolt-server exited (${code ?? 'signal'})`));
  console.log(`[dev] bolt-server  → http://127.0.0.1:${RUST_PORT}  (health: /api/health)`);
} else {
  console.warn(`[dev] bolt-server binary not found at ${serverBin} — UI-only dev.`);
}

// 3) Vite dev server (API proxy target is wired in vite.config.ts).
const ui = spawn('pnpm', ['exec', 'react-router', 'dev', '--host', '::', '--port', UI_PORT], {
  cwd: root,
  shell: isWin,
  env: { ...process.env, DEV_RUST_PORT: RUST_PORT },
});
children.push(ui);
tag(ui, 'vite');
ui.on('exit', (code) => {
  console.warn(`[dev] vite exited (${code ?? 'signal'})`);
  shutdown(code ?? 0);
});

console.log(`[dev] vite dev     → http://localhost:${UI_PORT}  (API proxy → :${RUST_PORT})`);
console.log('[dev] Ctrl+C stops both servers.');
