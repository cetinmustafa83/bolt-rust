import type { RouteConfig } from '@react-router/dev/routes';

/*
 * React Router's file-route helper currently pulls CommonJS lodash modules into
 * its ESM config runner, which prevents the dev server from starting. Keep the
 * same flat route URLs in a plain config until the upstream loader handles
 * those dependencies correctly.
 *
 * SPA mode: the app builds as a static bundle served by the native Rust
 * backend (backend-rs). There is no server runtime here, so there are no
 * server-side routes at all — the light API surface the app still needs
 * (models, health, configured-providers, check-env-key, update,
 * github-template, llm-relay, codegpt-login-channel) is implemented natively
 * in Rust, and every other /api/* path returns a clean 501 JSON response from
 * the same server. The former Remix/Cloudflare api.* route modules have been
 * removed entirely.
 */
export default [
  {
    file: 'routes/_index.tsx',
    children: [
      { file: 'routes/chat-home.tsx', index: true },
      { file: 'routes/chat.$id.tsx', path: 'chat/:id' },
    ],
  },
  { file: 'routes/git.tsx', path: '/git' },
  { file: 'routes/starter.tsx', path: '/starter' },

  /*
   * routes/webcontainer.connect.$id.tsx was a server-only route that returned
   * a raw HTML document for the StackBlitz editor connect flow; the Rust
   * backend serves that HTML natively and the dead module has been removed.
   */
  { file: 'routes/webcontainer.preview.$id.tsx', path: '/webcontainer/preview/:id' },
] satisfies RouteConfig;
