// Minimal static server for the e2e fixture: serves the repo root so the page can import the built bundle.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const port = Number(process.env.PORT ?? 5199);

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  const file = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return res.writeHead(403).end();
  try {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`e2e server on ${port}`));
