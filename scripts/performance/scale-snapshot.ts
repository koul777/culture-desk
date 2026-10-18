import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argumentsOf, saveJson, snapshotInfo, workspace } from './common.js';

const args = argumentsOf();
if (!args.out || !args.manifest) throw new Error('--out and --manifest are required; use an ignored data/ destination for the snapshot');
const rows = Number(args.rows ?? '11298'), coordinates = args.coordinates ?? 'preserve';
if (!Number.isSafeInteger(rows) || rows < 0 || rows > 100000 || !['preserve', 'spread', 'dense', 'missing'].includes(coordinates)) throw new Error('Invalid derived corpus specification');
if (args.partial && !['true', 'false'].includes(args.partial)) throw new Error('--partial must be true or false');
if (args.minimal && !['true', 'false'].includes(args.minimal)) throw new Error('--minimal must be true or false');
const partial = args.partial === 'true', minimal = args.minimal === 'true';
const wideCharacters = Number(args['wide-characters'] ?? '0');
if (!Number.isSafeInteger(wideCharacters) || wideCharacters < 0 || wideCharacters > 300000 || (wideCharacters && rows > 20)) throw new Error('Wide-string fixture must have at most 20 rows and 0–300000 characters per title/venue');
const destination = resolve(args.out);
if (!destination.startsWith(resolve(workspace, 'data') + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Derived snapshots must stay in workspace data/');
const original = await snapshotInfo(resolve(args.root ?? workspace));
const performances = Array.from({ length: rows }, (_, index) => {
  const source = original.snapshot.performances[index % original.count];
  const item: any = minimal ? {
    id: index + 1, source: source.source, sourceId: `qa-scale-${index + 1}`, title: `TEST ${index + 1}`, cityId: source.cityId,
    startDate: source.startDate, endDate: source.endDate, genre: source.genre, sourceGenre: '', venue: 'TEST venue', address: '', poster: '',
    sourceUrl: '', price: '', priceType: 'unknown', age: '', runtime: '', cast: '', producer: '', organizer: '', contact: '', schedule: '', description: '', status: '',
    detailState: source.detailState, classification: source.classification, reviewReason: '', updatedAt: source.updatedAt,
  } : { ...source, id: index + 1, sourceId: `qa-scale-${index + 1}-${source.sourceId}` };
  if (minimal) for (const key of ['latitude', 'longitude', 'locationPrecision']) if (source[key] !== undefined) item[key] = source[key];
  if (wideCharacters) { item.title = '가'.repeat(wideCharacters); item.venue = '나'.repeat(wideCharacters); }
  if (coordinates === 'dense') { item.latitude = 37.55; item.longitude = 126.99; item.locationPrecision = 'venue'; }
  if (coordinates === 'spread') {
    // Deterministic synthetic grid inside the application's accepted coordinate bounds.
    // Some points are offshore; this is deliberately a geometry stress corpus, not real venues.
    item.latitude = 33.05 + (index % 100) * .058;
    item.longitude = 124.05 + (Math.floor(index / 100) % 1000) * .0078;
    item.locationPrecision = 'venue';
  }
  if (coordinates === 'missing') { delete item.latitude; delete item.longitude; delete item.locationPrecision; }
  if (partial && index % 17 === 0) item.detailState = 'pending';
  return item;
});
const coverage = partial ? { ...original.snapshot.coverage, pairs: original.snapshot.coverage.pairs.slice(1) } : original.snapshot.coverage;
const text = JSON.stringify({ ...original.snapshot, coverage, performances }) + '\n';
if (Buffer.byteLength(text) > 64 * 1024 * 1024 || text.length > 64 * 1024 * 1024) throw new Error('Derived artifact exceeds decoded 64 MiB budget; use --minimal true or fewer rows');
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, text, { flag: 'wx' });
const result = await snapshotInfo(workspace, destination);
await saveJson(args.manifest, { version: 1, generatedAt: new Date().toISOString(), source: { hash: original.hash, rows: original.count },
  derived: { path: destination, hash: result.hash, rows: result.count, bytes: result.bytes, decodedCodeUnits: text.length }, coordinates, partial, minimal, wideCharacters,
  partialChanges: partial ? { removedCoveragePair: original.snapshot.coverage.pairs[0], pendingDetails: performances.filter(row => row.detailState === 'pending').length } : undefined,
  contract: 'Synthetic scale corpus: cycles original rows and assigns unique id/sourceId. Content/timestamps/coverage are preserved except explicit coordinate, partial, minimal and wide-string options. Partial removes one coverage pair and marks every 17th detail pending. Minimal retains required keys, source/city/date/genre/detail/classification/time and optional coordinates, replaces titles/venues with ASCII exemplars and empties detail strings. Wide-string explicitly replaces titles/venues with repeated Korean characters. Does not overwrite production assets. Dense/spread/missing are stress-only and not real-world distribution claims.' });
console.log(JSON.stringify({ out: destination, manifest: args.manifest, rows, bytes: result.bytes, hash: result.hash, coordinates }));
