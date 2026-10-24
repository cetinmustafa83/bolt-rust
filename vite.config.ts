/*
 * SPA build configuration.
 *
 * The Cloudflare worker target was removed: the backend is now a native Rust
 * server (backend-rs) and the app builds as a static SPA (`ssr: false` in
 * react-router.config.ts). The browser polyfills for `Buffer` / `process` /
 * `global` remain — the client bundle (including the Comlink chat worker)
 * still needs them for Node-flavoured dependencies.
 */
import { reactRouter } from '@react-router/dev/vite';
import * as dotenv from 'dotenv';
import UnoCSS from 'unocss/vite';
import { defineConfig, type ViteDevServer } from 'vite';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import { browserPolyfills } from './scripts/vite/browser-polyfills.ts';

// Load environment variables without duplicate loading or console noise
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

export default defineConfig((config) => {
  return {
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),

      // Ensure process.cwd is defined as a function for path-browserify compatibility
      'process.cwd': '() => "/"',
    },
    resolve: {
      tsconfigPaths: true,
    },
    // Sandbox: app is reached through a reverse proxy (Next.js gateway), so
    // allow any Host header on both dev and preview servers.
    server: {
      allowedHosts: true,
    },
    preview: {
      allowedHosts: true,
    },
    build: {
      target: 'esnext',
    },
    /*
     * Workers are instantiated with `{ type: 'module' }` (Comlink chat worker,
     * ripgrep worker, syntax highlighter), so the worker bundles must be real
     * ES modules — vite's default 'iife' format breaks module workers with an
     * immediate, message-less error event.
     */
    worker: {
      format: 'es',
    },
    optimizeDeps: {
      include: [
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom',
        'react-dom/client',
        'react-router',
        'react-router/dom',
        'remix-utils/client-only',
        '@nanostores/react',
        'nanostores',
        'zustand',
        'framer-motion',
        'ai',
        '@ai-sdk/react',
        '@ai-sdk/amazon-bedrock',
        '@ai-sdk/cerebras',
        '@ai-sdk/cohere',
        '@ai-sdk/deepseek',
        '@ai-sdk/fireworks',
        '@ai-sdk/google',
        '@ai-sdk/mistral',
        '@ai-sdk/mcp', // AI SDK 7 MCP integration
        '@modelcontextprotocol/sdk/client/index.js',
        '@modelcontextprotocol/sdk/inMemory.js',
        '@modelcontextprotocol/sdk/server/mcp.js',
        'zod',
        '@ai-sdk/openai',
        '@openrouter/ai-sdk-provider',
        'ollama-ai-provider-v2',
        '@radix-ui/react-checkbox',
        '@radix-ui/react-collapsible',
        '@radix-ui/react-context-menu',
        '@radix-ui/react-dialog',
        '@radix-ui/react-dropdown-menu',
        '@radix-ui/react-label',
        '@radix-ui/react-popover',
        '@radix-ui/react-scroll-area',
        '@radix-ui/react-switch',
        '@radix-ui/react-tabs',
        '@radix-ui/react-tooltip',
        'react-toastify',
        '@bjorn3/browser_wasi_shim',

        /*
         * These imports are added by Vite/React Router transforms, so the
         * dependency scanner cannot reliably see them before the browser does.
         * Pre-bundle them up front to avoid invalidating optimized URLs on the
         * first page load (504 "Outdated Optimize Dep").
         */
        '@octokit/rest',
        'vite-plugin-node-polyfills/shims/buffer',
        'vite-plugin-node-polyfills/shims/process',

        'class-variance-authority',
        'react-markdown',
        'remark-gfm',
        'rehype-raw',
        'rehype-sanitize',
        'unist-util-visit',
        'shiki',
        '@codemirror/autocomplete',
        '@codemirror/commands',
        '@codemirror/lang-cpp',
        '@codemirror/lang-css',
        '@codemirror/lang-html',
        '@codemirror/lang-javascript',
        '@codemirror/lang-json',
        '@codemirror/lang-markdown',
        '@codemirror/lang-python',
        '@codemirror/lang-sass',
        '@codemirror/lang-vue',
        '@codemirror/lang-wast',
        '@codemirror/language',
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        '@uiw/codemirror-theme-vscode',
        '@xterm/xterm',
        '@xterm/addon-fit',
        '@xterm/addon-web-links',
        '@webcontainer/api',
        'diff',
        'date-fns',
        'js-cookie',
        'jszip',
        'file-saver',
        'path-browserify',
        'chart.js',
        'react-chartjs-2',
        'react-resizable-panels',
        'react-dnd',
        'react-dnd-html5-backend',
        'react-window',
        'react-qrcode-logo',
        'isomorphic-git',
        'isomorphic-git/http/web',
        'istextorbinary',
        'ignore',
        'chalk',
        'lucide-react',
        'jspdf',
        'react-icons/bi',
        'react-icons/bs',
        'react-icons/fa',
        'react-icons/si',
        'react-icons/tb',
      ],
    },
    environments: {
      client: {
        /*
         * React Router reads `build/client/.vite/manifest.json` while bundling
         * the client; request it explicitly so the SPA build stays consistent.
         */
        build: { manifest: true },
      },
    },
    plugins: [
      browserPolyfills(),
      reactRouter(),
      UnoCSS(),
      chrome129IssuePlugin(),
      config.mode === 'production' && optimizeCssModules({ apply: 'build' }),
    ],
    envPrefix: [
      'VITE_',
      'OPENAI_LIKE_API_BASE_URL',
      'OPENAI_LIKE_API_MODELS',
      'OLLAMA_API_BASE_URL',
      'LMSTUDIO_API_BASE_URL',
      'TOGETHER_API_BASE_URL',
    ],

    /*
     * Test configuration lives in vitest.config.ts.
     *
     * It used to live here, which meant the test runner loaded this file and
     * therefore the whole application build - the Cloudflare plugin, the React
     * Router plugin, UnoCSS and the browser-polyfill transform. Those are
     * individually guarded by `config.mode !== 'test'`, but keeping them in one
     * file couples the test environment to the build graph: a plugin added for
     * the app can change how tests behave. Split apart, the runner never reads
     * this file at all.
     */
  };
});

function chrome129IssuePlugin() {
  return {
    name: 'chrome129IssuePlugin',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const raw = req.headers['user-agent']?.match(/Chrom(e|ium)\/([0-9]+)\./);

        if (raw) {
          const version = parseInt(raw[2], 10);

          if (version === 129) {
            res.setHeader('content-type', 'text/html');
            res.end(
              '<body><h1>Please use Chrome Canary for testing.</h1><p>Chrome 129 has an issue with JavaScript modules & Vite local development, see <a href="https://github.com/stackblitz/bolt.new/issues/86#issuecomment-2395519258">for more information.</a></p><p><b>Note:</b> This only impacts <u>local development</u>. `pnpm run build` and `pnpm run start` will work fine in this browser.</p></body>',
            );

            return;
          }
        }

        next();
      });
    },
  };
}
