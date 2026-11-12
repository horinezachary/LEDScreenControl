// The web layer: the built dashboard as static files, the current state as JSON, and a WebSocket that pushes the
// state to every open browser whenever a poll finishes. Browsers never talk to a processor directly.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerMessage } from '@ledmon/shared';
import type { Monitor } from './monitor.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const FALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>LED Monitor</title>
<body style="font-family:system-ui;padding:40px;background:#0e1116;color:#e8ebf0"><div id="root">
<h1>The dashboard is not built</h1><p>Run <code>scripts/build.sh</code>, then restart. The JSON state is at <a style="color:#7fb0ff" href="/api/state">/api/state</a>.</p></div>`;

export function createHttpServer(monitor: Monitor, webRoot?: string): http.Server {
  const root = webRoot && fs.existsSync(path.join(webRoot, 'index.html')) ? path.resolve(webRoot) : undefined;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(monitor.state()));
      return;
    }
    if (!root) {
      res.writeHead(200, { 'content-type': TYPES['.html'] }).end(FALLBACK_PAGE);
      return;
    }
    serveStatic(root, url.pathname, res);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  const send = (ws: WebSocket) => {
    if (ws.readyState !== ws.OPEN) return;
    const msg: ServerMessage = { type: 'state', state: monitor.state() };
    ws.send(JSON.stringify(msg));
  };
  wss.on('connection', (ws) => send(ws));

  // Many processors can finish polling in the same instant; send one update per 250 ms at most.
  let pending: NodeJS.Timeout | undefined;
  monitor.on('change', () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      for (const ws of wss.clients) send(ws);
    }, 250);
  });
  server.on('close', () => {
    clearTimeout(pending);
    wss.close();
  });
  return server;
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse): void {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // A single-page app: unknown paths get the page, which routes itself.
    file = path.join(root, 'index.html');
  }
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
  const cache = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  fs.createReadStream(file).pipe(res);
}
