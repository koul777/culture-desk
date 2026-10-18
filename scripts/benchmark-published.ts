import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import type { CloudOptions } from '../server/cloud/handler.js';
import { loadReadonlyFallback, readPublicSnapshot } from '../server/cloud/readonly-fallback.js';

// Offline benchmark: only the bundled public snapshot and in-memory SQLite are used.
// Run alone before/after a change; do not compare measurements taken during builds.
const snapshotPath = fileURLToPath(new URL('../server/assets/public-snapshot.json', import.meta.url));
const output = process.argv[2];
if (!output) throw new Error('Usage: node --import tsx scripts/benchmark-published.ts <report.json> [handler module relative to scripts/]');
const handler = new URL(process.argv[3] || '../server/cloud/handler.ts', import.meta.url);
const { handleCloudRequest } = await import(handler.href) as typeof import('../server/cloud/handler.js');
const snapshot = await readPublicSnapshot(snapshotPath);
const from = snapshot.coverage?.from ?? '2026-10-01';
const to = snapshot.coverage?.to ?? '2027-01-17';
const window = `from=${from}&to=${to}`;
const firstId = snapshot.performances[0].id;
const routes = [
  ['/api/bootstrap', 'bootstrap'],
  [`/api/performances?${window}`, 'national-search'],
  [`/api/performances?${window}&cities=yeosu,wonju`, 'regional-search'],
  [`/api/map?${window}`, 'national-map'],
  [`/api/map?${window}&cities=yeosu,wonju`, 'regional-map'],
  [`/api/performances/${firstId}`, 'detail'],
] as const;
function digest(text: string) {
  // Search timestamps are generated per read; all other response values must match.
  const data = JSON.parse(text);
  return createHash('sha256').update(JSON.stringify(data, (key, value) => key === 'snapshotAt' ? undefined : value)).digest('hex');
}
const stats = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b);
  return { samples: values.length, medianMs: +ordered[Math.floor(ordered.length / 2)].toFixed(3), p95Ms: +ordered[Math.ceil(ordered.length * .95) - 1].toFixed(3), minMs: +ordered[0].toFixed(3) };
};
async function read(route: string, options: CloudOptions) {
  const started = performance.now();
  const response = await handleCloudRequest(new Request(`https://benchmark.test${route}`), options);
  const body = await response.text();
  if (response.status !== 200) throw new Error(`Benchmark ${route}: HTTP ${response.status}`);
  return { elapsed: performance.now() - started, bytes: Buffer.byteLength(body), hash: digest(body) };
}
const cold: number[] = [];
for (let index = 0; index < 5; index++) {
  const fallback = { load: () => readPublicSnapshot(snapshotPath) };
  cold.push((await read(routes[1][0], { env: {}, readonlyFallback: fallback })).elapsed);
  (await loadReadonlyFallback(fallback))?.store.close();
}
const fallback = { load: async () => snapshot };
const options: CloudOptions = { env: {}, readonlyFallback: fallback };
const measurements = [];
for (const [route, name] of routes) {
  const first = await read(route, options);
  for (let index = 0; index < 3; index++) await read(route, options);
  const samples = [];
  for (let index = 0; index < 30; index++) samples.push(await read(route, options));
  if (new Set(samples.map(value => value.hash)).size !== 1) throw new Error(`Unstable response: ${name}`);
  measurements.push({ name, route, firstMs: +first.elapsed.toFixed(3), ...stats(samples.map(value => value.elapsed)), bytes: samples[0].bytes, responseHash: samples[0].hash });
}
const filters = ['', '&cities=andong', '&cities=yeosu,wonju', '&source=kopis', '&source=culture', '&price=free', '&price=paid', '&price=unknown', '&q=음악', '&genre=연극', '&page=2&limit=20', '&status=upcoming', '&cities=gangneung', '&q=%25', '&age=전체'];
const parity = [];
for (const prefix of ['/api/performances', '/api/map']) for (const filter of filters) {
  const route = `${prefix}?${window}${filter}`;
  parity.push({ route, hash: (await read(route, options)).hash });
}
const exportRoute = `/api/export.xlsx?${window}&cities=yeosu,wonju`;
const exportStart = performance.now();
const exported = await handleCloudRequest(new Request(`https://benchmark.test${exportRoute}`), options);
if (exported.status !== 200) throw new Error(`Export benchmark: HTTP ${exported.status}`);
const exportBytes = Buffer.from(await exported.arrayBuffer());
const exportMs = performance.now() - exportStart;
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(exportBytes as any);
const exportValues = workbook.worksheets.map(sheet => ({ name: sheet.name, rows: sheet.getSheetValues().map((row, index) =>
  sheet.name === '조회 근거' && index === 2 ? ['추출 시각', '<per-read time>'] : row) }));
const report = {
  measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, handler: handler.pathname,
  scope: 'Offline handleCloudRequest + response serialization; excludes process import/startup, network and browser rendering',
  snapshotBytes: readFileSync(snapshotPath).byteLength,
  snapshotHash: createHash('sha256').update(readFileSync(snapshotPath)).digest('hex'),
  performances: snapshot.performances.length, coldRead: stats(cold), measurements, parity,
  export: { route: exportRoute, samples: 1, elapsedMs: +exportMs.toFixed(3), bytes: exportBytes.byteLength,
    rows: workbook.getWorksheet('공연 목록')!.rowCount - 1, contentsHash: createHash('sha256').update(JSON.stringify(exportValues)).digest('hex') },
};
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: output, coldRead: report.coldRead, measurements }, null, 2));
(await loadReadonlyFallback(fallback))?.store.close();
