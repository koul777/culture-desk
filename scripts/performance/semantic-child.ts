import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, saveJson, semanticHash, sha256, snapshotInfo, sourceFingerprint, workspace } from './common.js';
import { semanticCases } from './semantic-cases.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
if (!args.out) throw new Error('--out is required');
const info = await snapshotInfo(root, args.snapshot), before = await sourceFingerprint(root, ['server', 'shared']);
globalThis.fetch = async () => { throw new Error('Semantic harness forbids outbound fetch'); };
const { handleCloudRequest } = await import(pathToFileURL(resolve(root, 'server/cloud/handler.ts')).href);
const options = { env: {}, readonlyFallback: { load: async () => info.snapshot } };
const raw = [];
for (const entry of semanticCases(info.snapshot)) {
  const response = await handleCloudRequest(new Request(`http://semantic.test${entry.route}`, { method: entry.method }), options);
  const bytes = Buffer.from(await response.arrayBuffer());
  let payload: unknown, perReadTimes: unknown;
  if (!bytes.length) payload = null;
  else if (response.headers.get('content-type')?.includes('application/json')) payload = JSON.parse(bytes.toString('utf8'));
  else if (response.headers.get('content-type')?.includes('spreadsheet')) {
    const { workbookSemantics } = await import('./workbook.js');
    const value = await workbookSemantics(bytes); payload = value.payload;
    perReadTimes = { extractionTime: value.extractionTime, workbookCreated: value.created };
  } else payload = bytes.toString('utf8');
  const headers = Object.fromEntries([...response.headers].filter(([name]) => !['date', 'content-length'].includes(name)));
  raw.push({ ...entry, status: response.status, headers, bytes: bytes.length, wireHash: sha256(bytes), semanticHash: semanticHash(payload), payload, perReadTimes });
}
const after = await sourceFingerprint(root, ['server', 'shared']);
await saveJson(args.out, { root, snapshot: { hash: info.hash, count: info.count }, source: { before, afterHash: after.hash, stable: before.hash === after.hash }, raw });
if (before.hash !== after.hash) throw new Error('Source changed during semantic sweep');
console.log(JSON.stringify({ out: args.out, cases: raw.length }));
