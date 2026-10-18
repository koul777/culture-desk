import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, sha256, semanticHash, snapshotInfo, workspace } from './common.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
const info = await snapshotInfo(root, args.snapshot);
const { PublishedResponseCache } = await import(pathToFileURL(resolve(root, 'server/cloud/published-response-cache.ts')).href);
const original = PublishedResponseCache.prototype.read;
let mode = 'miss', observed = { read: 0, produce: 0, pendingBefore: 0, clearedEntries: 0 };
PublishedResponseCache.prototype.read = async function (key: string, day: string, produce: () => Promise<Response>) {
  const state = this as any;
  if (!(state.values instanceof Map) || !(state.pending instanceof Map) || typeof state.bytes !== 'number') throw new Error('Cache harness contract changed');
  observed.read++; observed.pendingBefore += state.pending.size;
  if (mode === 'miss') {
    if (state.pending.size) throw new Error('Concurrent pending cache entry invalidates sequential miss');
    observed.clearedEntries += state.values.size; state.values.clear(); state.bytes = 0;
  }
  return original.call(this, key, day, async () => { observed.produce++; return produce(); });
};
globalThis.fetch = async () => { throw new Error('Performance worker forbids outbound fetch'); };
const { handleCloudRequest } = await import(pathToFileURL(resolve(root, 'server/cloud/handler.ts')).href);
const options = { env: {}, readonlyFallback: { load: async () => info.snapshot } };
const verifiedBodies = new Map<string, { semanticHash: string; metadata: unknown }>();
let busy = false;
process.on('message', async (message: any) => {
  if (busy) { process.send?.({ id: message.id, error: 'Overlapping worker commands are forbidden' }); return; }
  busy = true;
  try {
    mode = message.mode;
    if (!['miss', 'hit'].includes(mode)) throw new Error('Invalid cache mode');
    observed = { read: 0, produce: 0, pendingBefore: 0, clearedEntries: 0 };
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    const response = await handleCloudRequest(new Request(`http://performance.test${message.route}`), options);
    const body = Buffer.from(await response.arrayBuffer());
    const elapsedMs = performance.now() - started;
    const cpuMicros = process.cpuUsage(cpuBefore);
    if (response.status !== 200 || observed.read !== 1 || observed.pendingBefore !== 0 || observed.produce !== (mode === 'miss' ? 1 : 0)) {
      throw new Error(`Unexpected response/cache state ${JSON.stringify({ status: response.status, mode, observed })}`);
    }
    // Always hash wire bytes, but parse/canonicalize a body only when its bytes change.
    // This avoids turning verification allocations into repeated GC work between samples.
    const wireHash = sha256(body);
    let verified = verifiedBodies.get(wireHash);
    if (!verified) {
      const payload = JSON.parse(body.toString('utf8'));
      verified = { semanticHash: semanticHash(payload), metadata: { snapshotAt: payload.snapshotAt, published: payload.published,
        total: payload.total, partial: payload.partial, truncated: payload.truncated, items: payload.items?.length } };
      verifiedBodies.set(wireHash, verified);
    }
    process.send?.({ id: message.id, result: { mode, route: message.route, elapsedMs, cpuMicros, bytes: body.byteLength, wireHash, ...verified,
      status: response.status, headers: Object.fromEntries(response.headers), cache: { ...observed }, memory: process.memoryUsage() } });
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
  finally { busy = false; }
});
process.on('disconnect', () => process.exit(0));
process.send?.({ type: 'api-worker-ready', root, node: process.version, snapshotHash: info.hash, count: info.count });
