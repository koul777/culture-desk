// A fresh child for each sample. No application package is imported before the import timer.
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, sha256, semanticHash } from './common.js';

const args = argumentsOf();
if (!args.root || !args.route) throw new Error('--root and --route are required');
const require = createRequire(import.meta.url);
const loaded = () => {
  const files = Object.keys(require.cache);
  return { total: files.length, exceljs: files.filter(file => /[\\/]node_modules[\\/]exceljs[\\/]/i.test(file)).length,
    pg: files.filter(file => /[\\/]node_modules[\\/]pg[\\/]/i.test(file)).length };
};
globalThis.fetch = async () => { throw new Error('Performance harness forbids outbound fetch'); };
const memoryBefore = process.memoryUsage();
const importStart = performance.now();
const { handleCloudRequest } = await import(pathToFileURL(resolve(args.root, 'server/cloud/handler.ts')).href);
const importMs = performance.now() - importStart;
const modulesAfterImport = loaded();
const start = performance.now();
const response = await handleCloudRequest(new Request(`http://performance.test${args.route}`), {
  env: {}, readonlyFallback: { artifactPath: resolve(args.root, 'server/assets/public-snapshot.json') },
});
const body = Buffer.from(await response.arrayBuffer());
const firstBodyReadySinceProcessStartMs = performance.now();
const firstResponseMs = firstBodyReadySinceProcessStartMs - start;
const modulesAfterResponse = loaded();
const memoryAfterResponse = process.memoryUsage();
if (response.status !== 200) throw new Error(`First response HTTP ${response.status}`);
let payload: any;
if (response.headers.get('content-type')?.includes('application/json')) payload = JSON.parse(body.toString('utf8'));
else {
  // Spreadsheet parsing/semantic checks occur after the response-ready timestamp.
  const { workbookSemantics } = await import('./workbook.js');
  payload = (await workbookSemantics(body)).payload;
}
process.stdout.write(JSON.stringify({ type: 'startup-result', route: args.route, importMs, firstResponseMs,
  preHandlerImportMs: importStart, firstBodyReadySinceProcessStartMs,
  importAndFirstResponseMs: importMs + firstResponseMs, bytes: body.byteLength, wireHash: sha256(body), semanticHash: semanticHash(payload),
  metadata: { snapshotAt: payload.snapshotAt, published: payload.published, exportedRows: payload.exportedRows }, status: response.status,
  modulesAfterImport, modulesAfterResponse, memoryBefore, memoryAfterResponse }) + '\n');
