/**
 * Mock CodeGPT SSE channel (Node, plain http) for leak-testing the Rust
 * login supervisor.
 * - GET  /api/v1/extensions/connection/:id → SSE keep-alive stream (2s)
 * - POST /push/:id                          → push a fake token frame once
 * - POST /close/:id                         → drop the upstream stream
 * - GET  /stats                             → { active: n }
 */
const http = require('node:http');

const active = new Map();

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ active: active.size }));

      return;
    }

    let m = url.pathname.match(/^\/push\/([A-Za-z0-9-]+)$/);

    if (m) {
      const ctrl = active.get(m[1]);

      if (ctrl) {
        ctrl.push();
        res.end('{"ok":true}');
      } else {
        res.statusCode = 404;
        res.end('{"ok":false}');
      }

      return;
    }

    m = url.pathname.match(/^\/close\/([A-Za-z0-9-]+)$/);

    if (m) {
      active.get(m[1])?.close();
      res.end('{"ok":true}');

      return;
    }

    m = url.pathname.match(/^\/api\/v1\/extensions\/connection\/([A-Za-z0-9-]+)$/);

    if (!m) {
      res.statusCode = 404;
      res.end('not found');

      return;
    }

    const id = m[1];
    let pushed = false;

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('retry: 1000\n\n');

    const keep = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        /* closed */
      }
    }, 2000);

    const cleanup = () => {
      clearInterval(keep);
      active.delete(id);
    };

    active.set(id, {
      push: () => {
        if (!pushed) {
          pushed = true;

          try {
            res.write(
              'data: {"access_token":"mock.jwt.token","refresh_token":"mock-refresh","expires_at":9999999999999}\n\n',
            );
          } catch {
            /* closed */
          }
        }
      },
      close: () => {
        cleanup();

        try {
          res.end();
        } catch {
          /* already closed */
        }
      },
    });

    req.on('close', cleanup);
  })
  .listen(3999, () => console.log('codegpt-mock (node) up on :3999'));
