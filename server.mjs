// Zero-dependency server for the grid demos: the /api protocol (see demo-backend.mjs for the
// endpoints and data) plus static files for examples/ and packages/. `npm start`, port 5174.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApiRequest } from './demo-backend.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');

const STATIC_DIRS = ['examples', 'packages'];
const PORT = Number(process.env.PORT ?? 5174);
const MAX_BODY_BYTES = 256 * 1024;

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError('body too large', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError('invalid JSON');
  }
}

async function handleApi(url, req, res) {
  const out = await handleApiRequest({
    url,
    method: req.method,
    readBody: () => readJsonBody(req),
    cancelled: () => req.socket.destroyed || res.destroyed,
  });
  if (out) sendJson(res, out.status, out.body);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function serveStatic(pathname, res) {
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(302, { Location: '/examples/vanilla/' });
    res.end();
    return;
  }
  let rel = normalize(decodeURIComponent(pathname));
  if (rel.endsWith(sep) || rel.endsWith('/')) rel += 'index.html';
  const file = join(ROOT, rel);
  const allowed = STATIC_DIRS.some((d) => file.startsWith(join(ROOT, d) + sep));
  if (!allowed || file.includes(`${sep}node_modules${sep}`)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(url, req, res);
    else await serveStatic(url.pathname, res);
  } catch (err) {
    if (err.status && err.status < 500) {
      if (!res.headersSent) sendJson(res, err.status, { error: err.message });
      return;
    }
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Virtual grid demo on http://localhost:${PORT}`);
});
