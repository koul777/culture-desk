import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, saveJson, sha256, statistics, workspace } from './common.js';

// Isolated representation experiment. The generated variant is kept under data/;
// production cache sources are never modified by this script.
const args = argumentsOf();
assert.ok(args.out, '--out is required');
const samples = Number(args.samples ?? '100');
assert.ok(Number.isSafeInteger(samples) && samples >= 10 && samples <= 1000);
const root = resolve(args.root ?? workspace);
const source = await readFile(resolve(root, 'server/cloud/published-response-cache.ts'), 'utf8');
const replacements = [
  ['bytes: Uint8Array<ArrayBuffer>', 'body: Blob'],
  ['const bytes = new Uint8Array(await response.arrayBuffer());', 'const body = new Blob([await response.arrayBuffer()]);'],
  ['{ bytes, headers: [...response.headers], status: response.status, size: bytes.byteLength }', '{ body, headers: [...response.headers], status: response.status, size: body.size }'],
  ['new Response(value.bytes,', 'new Response(value.body,'],
] as const;
let candidate = source;
for (const [before, after] of replacements) {
  assert.equal(candidate.split(before).length, 2, `Expected a single known cache source anchor: ${before}`);
  candidate = candidate.replace(before, after);
}
const variantFile = resolve(workspace, 'data/performance-session-20261019/cache-body', `${sha256(candidate)}.ts`);
await mkdir(dirname(variantFile), { recursive: true });
try { await writeFile(variantFile, candidate, { flag: 'wx' }); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; assert.equal(await readFile(variantFile, 'utf8'), candidate); }
const [{ PublishedResponseCache: BytesCache }, { PublishedResponseCache: BlobCache }] = await Promise.all([
  import(pathToFileURL(resolve(root, 'server/cloud/published-response-cache.ts')).href),
  import(pathToFileURL(variantFile).href),
]);
const raw: any[] = [], results: any[] = [];
for (const size of [256, 100_000, 1_654_588]) {
  const body = `{"payload":"${'a'.repeat(size - 14)}"}`;
  assert.equal(Buffer.byteLength(body), size);
  const expected = sha256(body);
  const variants = [{ name: 'bytes', cache: new BytesCache() }, { name: 'blob', cache: new BlobCache() }];
  for (const variant of variants) {
    const response = await variant.cache.read('body', 'fixed-day', async () => new Response(body, { headers: { 'Content-Type': 'application/json', 'X-Test': 'retained' } }));
    assert.equal(sha256(new Uint8Array(await response.arrayBuffer())), expected);
  }
  for (let index = -10; index < samples; index++) {
    for (const variant of index % 2 ? [...variants].reverse() : variants) {
      const cpu = process.cpuUsage(), start = performance.now();
      const response = await variant.cache.read('body', 'fixed-day', async () => { throw new Error('Expected a cache hit'); });
      const responseReadyMs = performance.now() - start;
      const buffer = await response.arrayBuffer();
      const consumedMs = performance.now() - start, cpuMicros = process.cpuUsage(cpu);
      assert.equal(response.headers.get('X-Test'), 'retained');
      assert.equal(buffer.byteLength, size);
      assert.equal(sha256(new Uint8Array(buffer)), expected);
      if (index >= 0) raw.push({ variant: variant.name, size, index, block: Math.min(2, Math.floor(index * 3 / samples)), responseReadyMs, consumedMs, cpuMicros });
    }
  }
  for (const variant of variants) {
    const rows = raw.filter(row => row.variant === variant.name && row.size === size);
    results.push({ variant: variant.name, size, responseReady: statistics(rows.map(row => row.responseReadyMs)),
      consumed: statistics(rows.map(row => row.consumedMs)), cpu: statistics(rows.map(row => (row.cpuMicros.user + row.cpuMicros.system) / 1000)),
      blocks: [0, 1, 2].map(block => ({ block, consumed: statistics(rows.filter(row => row.block === block).map(row => row.consumedMs)) })) });
  }
}
await saveJson(args.out, { at: new Date().toISOString(), node: process.version, samples, warmup: 10,
  scope: 'Exploratory in-process AB/BA cache-hit representation comparison, natural GC. Synthetic equal-size UTF-8 JSON. No HTTP transport, miss or concurrent workload. Does not establish an end-to-end improvement.',
  source: { baselineHash: sha256(source), candidateHash: sha256(candidate), variantFile }, results, raw });
console.log(JSON.stringify({ out: args.out, results }, null, 2));
