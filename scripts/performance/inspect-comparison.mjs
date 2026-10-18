import { readFile } from 'node:fs/promises';
const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
const include = row => !process.argv[3] || row.name === process.argv[3];
const compact = row => ({ variant: row.variant, name: row.name, mode: row.mode, n: row.samples,
  p50: row.p50Ms, p95: row.p95Ms, cpuMean: row.cpu?.meanMs, wallMean: row.meanMs });
console.log(JSON.stringify({ sourceStable: report.source?.map(row => row.stable), equality: report.equality,
  summary: report.summary?.filter(include).map(compact), blocks: report.timeBlocks?.map(block => ({ block: block.block, summary: block.summary?.filter(include).map(compact) })) }, null, 2));
