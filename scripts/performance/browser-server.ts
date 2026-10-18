import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { argumentsOf, snapshotInfo, workspace } from './common.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
const client = resolve(root, 'dist/client');
await stat(resolve(client, 'index.html'));
const info = await snapshotInfo(root, args.snapshot);
const compression = args.compression ?? 'gzip';
const cacheMode = args.cache ?? 'miss';
if (!['gzip', 'none'].includes(compression) || !['miss', 'normal'].includes(cacheMode)) throw new Error('Invalid fixture mode');
type Probe = { reads: number; produces: number; joined: number };
const scope = new AsyncLocalStorage<Probe>();
const { PublishedResponseCache } = await import(pathToFileURL(resolve(root, 'server/cloud/published-response-cache.ts')).href);
const original = PublishedResponseCache.prototype.read;
PublishedResponseCache.prototype.read = async function (key: string, day: string, produce: () => Promise<Response>) {
  const state = this as any, probe = scope.getStore();
  if (!(state.values instanceof Map) || !(state.pending instanceof Map)) throw new Error('Cache fixture contract changed');
  if (probe) { probe.reads++; if (state.pending.has(key)) probe.joined++; }
  if (cacheMode === 'miss') { state.values.clear(); state.bytes = 0; }
  return original.call(this, key, day, async () => { if (probe) probe.produces++; return produce(); });
};
globalThis.fetch = async () => { throw new Error('Browser fixture forbids server outbound fetch'); };
const { handleCloudRequest } = await import(pathToFileURL(resolve(root, 'server/cloud/handler.ts')).href);
const options = { env: {}, readonlyFallback: { load: async () => info.snapshot } };
const zip = promisify(gzip);
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = createServer(async (request, reply) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let body: Buffer, contentType: string;
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) { reply.writeHead(405); reply.end('Performance fixture is read only'); return; }
      const probe: Probe = { reads: 0, produces: 0, joined: 0 };
      const start = performance.now();
      const response = await scope.run(probe, () => handleCloudRequest(new Request(url, { method: request.method }), options));
      body = Buffer.from(await response.arrayBuffer());
      response.headers.forEach((value: string, name: string) => reply.setHeader(name, value));
      reply.statusCode = response.status;
      reply.setHeader('x-performance-handler-ms', String(performance.now() - start));
      reply.setHeader('x-performance-cache', JSON.stringify(probe));
      contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    } else {
      const pathname = decodeURIComponent(url.pathname);
      const file = resolve(client, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(client + sep)) { reply.writeHead(403); reply.end(); return; }
      body = await readFile(file);
      contentType = mime[extname(file)] ?? 'application/octet-stream';
    }
    reply.setHeader('content-type', contentType);
    reply.setHeader('cache-control', 'no-store');
    if (compression === 'gzip' && /json|javascript|text\/|svg/.test(contentType) && request.headers['accept-encoding']?.includes('gzip')) {
      body = await zip(body); reply.setHeader('content-encoding', 'gzip');
    }
    reply.setHeader('content-length', body.byteLength);
    reply.end(body);
  } catch (error) {
    reply.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500); reply.end('Performance fixture error');
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(error);
  }
});
server.listen(Number(args.port ?? '0'), '127.0.0.1', async () => {
  // Prime only the model/router outside browser timings; responses remain misses in miss mode.
  await handleCloudRequest(new Request('http://performance.test/api/bootstrap'), options);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  console.log(JSON.stringify({ type: 'browser-server-ready', url: `http://127.0.0.1:${address.port}`, cacheMode, compression,
    snapshotHash: info.hash, performances: info.count }));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(); server.closeAllConnections(); });
