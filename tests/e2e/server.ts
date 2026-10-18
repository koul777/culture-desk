// Isolated QA adapter: built UI + real published API + synthetic data. Never load .env or the production snapshot.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleCloudRequest, type CloudOptions } from '../../server/cloud/handler.js';
import { FIXTURE_DAY, publishedFixture } from './fixture.js';

const root = fileURLToPath(new URL('../../dist/client/', import.meta.url));
await stat(resolve(root, 'index.html')); // test:e2e must inspect a completed production build.
globalThis.fetch = async () => { throw new Error('QA server forbids outbound network requests'); };
const options: CloudOptions = { env: {}, readonlyFallback: { load: async () => publishedFixture } };
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = createServer(async (request, reply) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:4339');
    if (url.pathname === '/__qa/ready') { reply.writeHead(200, { 'content-type': 'application/json' }); reply.end('{"fixture":"published-e2e"}'); return; }
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) { reply.writeHead(405); reply.end('QA is read only'); return; }
      const response = await handleCloudRequest(new Request(url, { method: request.method }), options);
      response.headers.forEach((value, name) => reply.setHeader(name, value));
      reply.statusCode = response.status;
      // Keep default date filters stable on every calendar day, without replacing the API payload or logic.
      if (url.pathname === '/api/bootstrap' && request.method !== 'HEAD' && response.ok) {
        reply.end(JSON.stringify({ ...await response.json(), today: FIXTURE_DAY }));
      } else reply.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { reply.writeHead(403); reply.end(); return; }
    const body = await readFile(file);
    reply.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    reply.end(body);
  } catch (error) {
    reply.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500);
    reply.end('QA request failed');
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(error);
  }
});
server.listen(4339, '127.0.0.1', () => console.log('Published TEST fixture: http://127.0.0.1:4339'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(); server.closeAllConnections(); });
