import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Performance, Source } from '../shared/types.js';
import { cleanVenueInfo, venueInfoFromSource } from '../server/venue-info.js';
import type { PublishedCoverage, PublishedRefresh } from '../server/cloud/readonly-fallback.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';

export type PublicFallbackPerformance = Omit<Performance, 'bookmarked' | 'note'>;
export interface PublicFallbackSnapshot {
  version: 1;
  /** Time the data was published, or of the verified backup; not the time this export was created. */
  snapshotAt: string;
  generatedAt: string;
  refresh?: PublishedRefresh;
  coverage?: PublishedCoverage;
  performances: PublicFallbackPerformance[];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_FIELDS = [
  'title', 'genre', 'sourceGenre', 'venue', 'address', 'poster', 'sourceUrl',
  'price', 'priceType', 'age', 'runtime', 'cast', 'producer', 'organizer',
  'contact', 'schedule', 'description', 'status', 'reviewReason',
] as const;
const GENRES = new Set(['연극', '뮤지컬', '음악', '국악', '무용', '복합공연', '기타']);
const DETAILS = new Set(['pending', 'complete', 'failed']);
const PRICES = new Set(['free', 'paid', 'unknown']);
// Match credential-bearing values, never print a matched value in diagnostics.
const SECRET_PATTERNS = [
  /postgres(?:ql)?:\/\//i,
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/,
  /\b(?:KOPIS_API_KEY|CULTURE_API_KEY|VWORLD_API_KEY|DATABASE_URL|CRON_SECRET)\s*[=:]/i,
  /[?&](?:service(?:key)?|api[_-]?key|access[_-]?token|auth[_-]?key|secret)\s*=/i,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+\S+/i,
];
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

function invalid(id: unknown, field: string): never {
  throw new Error(`Public export rejected: row ${Number(id)} has invalid ${field}.`);
}
function assertNoCredentials(value: string, id: number, field: string) {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (SECRET_PATTERNS.some(pattern => pattern.test(decoded))) invalid(id, `credential-like content in ${field}`);
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { break; }
  }
}
function iso(value: unknown, id: number, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(id, field);
  return value;
}
function parsedRaw(value: unknown): unknown {
  try { return typeof value === 'string' ? JSON.parse(value) : null; } catch { return null; } // Venue facts are optional.
}
function project(row: Record<string, unknown>, raw: unknown): PublicFallbackPerformance {
  const id = Number(row.id);
  if (!Number.isSafeInteger(id) || id < 1) invalid(id, 'id');
  const data: unknown = JSON.parse(String(row.data));
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid(id, 'data');
  const source = data as Record<string, unknown>;
  // Explicit assignment is intentional: never spread the stored/provider object.
  const selected: Record<string, string | number> = {};
  for (const field of TEXT_FIELDS) {
    if (typeof source[field] !== 'string') invalid(id, field);
    selected[field] = source[field];
  }
  for (const [column, field] of [
    ['source', 'source'], ['source_id', 'sourceId'], ['city_id', 'cityId'],
    ['start_date', 'startDate'], ['end_date', 'endDate'], ['detail_state', 'detailState'],
  ] as const) {
    if (typeof row[column] !== 'string') invalid(id, column);
    selected[field] = row[column];
  }
  if (!['kopis', 'culture'].includes(String(selected.source))) invalid(id, 'source');
  if (!GENRES.has(String(selected.genre))) invalid(id, 'genre');
  if (!PRICES.has(String(selected.priceType))) invalid(id, 'priceType');
  if (!DETAILS.has(String(selected.detailState))) invalid(id, 'detailState');
  if (!selected.sourceId || !selected.cityId) invalid(id, 'sourceId/cityId');
  for (const field of ['startDate', 'endDate'] as const) {
    const value = String(selected[field]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0, 10) !== value) invalid(id, field);
  }
  if (selected.startDate > selected.endDate) invalid(id, 'date range');
  for (const [field, minimum, maximum] of [['latitude', 33, 39], ['longitude', 124, 132]] as const) {
    if (source[field] !== undefined) {
      const value = source[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalid(id, field);
      selected[field] = value;
    }
  }
  if (source.locationPrecision !== undefined) {
    if (!['venue', 'city'].includes(String(source.locationPrecision))) invalid(id, 'locationPrecision');
    selected.locationPrecision = String(source.locationPrecision);
  }
  const item = { ...selected, id, updatedAt: iso(row.updated_at, id, 'updatedAt'), classification: 'performance' } as PublicFallbackPerformance;
  // Only whitelisted public facility facts leave the provider payload.
  // Rows seeded from an earlier snapshot have no payload yet and keep their published facts.
  const venueInfo = venueInfoFromSource(raw, item.venue) ?? cleanVenueInfo(source.venueInfo, item.venue);
  if (venueInfo) item.venueInfo = venueInfo;
  for (const [field, value] of Object.entries(item)) assertNoCredentials(typeof value === 'string' ? value : JSON.stringify(value), id, field);
  return item;
}

/** Region/source pairs fully covered for the window, by the same precedence rule as Store.search. */
function coveredPairs(db: DatabaseSync, from: string, to: string): string[] {
  const cities = new Set(NATIONAL_CITIES.map(city => city.id));
  return db.prepare(`SELECT city_id,source,
    MAX(CASE WHEN state='complete' AND from_date<=? AND to_date>=? THEN id END) AS complete_id,
    MAX(CASE WHEN state!='complete' AND from_date<=? AND to_date>=? THEN id END) AS incomplete_id
    FROM sync_runs WHERE detail_only=0 GROUP BY city_id,source ORDER BY source,city_id`).all(from, to, to, from)
    .filter(row => row.complete_id !== null && (row.incomplete_id === null || Number(row.incomplete_id) < Number(row.complete_id)))
    .map(row => `${row.source}:${row.city_id}`).filter(pair => cities.has(pair.split(':')[1]));
}
/** One record per line: a day's changes stay small in git history, unlike a recompressed file. */
function serialize(snapshot: PublicFallbackSnapshot): string {
  const { performances, ...head } = snapshot;
  return `${JSON.stringify(head).slice(0, -1)},"performances":[\n${performances.map(item => JSON.stringify(item)).join(',\n')}\n]}\n`;
}

export function buildPublicFallback(options: { input?: string; output?: string; snapshotAt?: string; refresh?: PublishedRefresh } = {}) {
  const input = path.resolve(options.input ?? path.join(ROOT, 'data/performance-baseline/production-after.db'));
  const output = path.resolve(options.output ?? path.join(ROOT, 'server/assets/public-snapshot.json'));
  if (input === output || !/\.json(\.gz)?$/.test(output)) throw new Error('Use a separate .json or .json.gz output artifact.');
  if (existsSync(`${input}-wal`) && statSync(`${input}-wal`).size > 0) throw new Error('Use a closed, verified backup without an active WAL.');
  const before = readFileSync(input);
  const inputSha256 = sha256(before);
  const snapshotAt = options.snapshotAt ?? statSync(input).mtime.toISOString();
  if (!Number.isFinite(Date.parse(snapshotAt))) throw new Error('Invalid snapshot time.');
  const db = new DatabaseSync(input, { readOnly: true });
  let records = 0;
  let performances: PublicFallbackPerformance[];
  let coverage: PublishedCoverage | undefined;
  try {
    const check = db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('Backup integrity check failed.');
    records = Number(db.prepare('SELECT count(*) AS n FROM performances').get()!.n);
    // Provider payloads are read one row at a time only to derive venue facts.
    // Bookmarks and notes are never read; collection runs only yield coverage pairs.
    const rawOf = db.prepare('SELECT raw FROM performance_sources WHERE performance_id=?');
    performances = db.prepare(`SELECT id,source,source_id,city_id,start_date,end_date,detail_state,data,updated_at
      FROM performances WHERE classification='performance' ORDER BY id`).all().map(row => project(row, parsedRaw(rawOf.get(Number(row.id))?.raw)));
    if (!performances.length) throw new Error('The backup contains no public performances.');
    if (new Set(performances.map(item => item.id)).size !== performances.length) throw new Error('Duplicate public IDs.');
    const { from, to } = options.refresh ?? {};
    if (from && to) coverage = { from, to, pairs: coveredPairs(db, from, to) };
  } finally { db.close(); }
  if (inputSha256 !== sha256(readFileSync(input))) throw new Error('Source backup changed while exporting.');
  const snapshot: PublicFallbackSnapshot = { version: 1, snapshotAt, generatedAt: new Date().toISOString(),
    ...(options.refresh ? { refresh: options.refresh } : {}), ...(coverage ? { coverage } : {}), performances };
  const text = serialize(snapshot);
  if (JSON.parse(text).performances.length !== performances.length) throw new Error('Public snapshot serialization verification failed.');
  const bytes = Buffer.from(text);
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Public snapshot exceeds the decoded size budget.');
  const compressed = gzipSync(bytes, { level: 9 });
  if (compressed.length > 16 * 1024 * 1024) throw new Error('Public snapshot exceeds the compressed size budget.');
  if (!gunzipSync(compressed).equals(bytes)) throw new Error('Public snapshot compression verification failed.');
  const artifact = output.endsWith('.gz') ? compressed : bytes;
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, artifact, { flag: 'wx' }); renameSync(temporary, output); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  const sourceCounts: Record<Source, number> = { kopis: 0, culture: 0 };
  const detailCounts = { pending: 0, complete: 0, failed: 0 };
  for (const item of performances) { sourceCounts[item.source]++; detailCounts[item.detailState]++; }
  return { snapshotAt, generatedAt: snapshot.generatedAt, records, publicPerformances: performances.length,
    omittedNonPublic: records - performances.length, sourceCounts, detailCounts,
    citiesWithPerformances: new Set(performances.map(item => item.cityId)).size,
    venueCoordinates: performances.filter(item => item.locationPrecision === 'venue' && item.latitude !== undefined && item.longitude !== undefined).length,
    venueInfo: performances.filter(item => item.venueInfo).length, coveredPairs: coverage?.pairs.length ?? null,
    decodedBytes: bytes.length, compressedBytes: compressed.length, inputSha256, artifactSha256: sha256(artifact),
    sourceUnchanged: true, credentialPatternMatches: 0, privateFieldsExported: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 4) throw new Error('Usage: node --import tsx scripts/build-public-fallback.ts [backup.db] [output.json|output.json.gz]');
  console.log(JSON.stringify(buildPublicFallback({ input: process.argv[2], output: process.argv[3] }), null, 2));
}
