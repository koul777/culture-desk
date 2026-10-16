import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Performance, Source } from '../shared/types.js';

export type PublicFallbackPerformance = Omit<Performance, 'bookmarked' | 'note'>;
export interface PublicFallbackSnapshot {
  version: 1;
  /** Time of the verified backup, not the time this export was created. */
  snapshotAt: string;
  generatedAt: string;
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
function project(row: Record<string, unknown>): PublicFallbackPerformance {
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
  for (const [field, value] of Object.entries(item)) if (typeof value === 'string') assertNoCredentials(value, id, field);
  return item;
}

export function buildPublicFallback(options: { input?: string; output?: string } = {}) {
  const input = path.resolve(options.input ?? path.join(ROOT, 'data/performance-baseline/production-after.db'));
  const output = path.resolve(options.output ?? path.join(ROOT, 'server/data/public-snapshot.json.gz'));
  if (input === output || !output.endsWith('.json.gz')) throw new Error('Use a separate .json.gz output artifact.');
  if (existsSync(`${input}-wal`) && statSync(`${input}-wal`).size > 0) throw new Error('Use a closed, verified backup without an active WAL.');
  const before = readFileSync(input);
  const inputSha256 = sha256(before);
  const snapshotAt = statSync(input).mtime.toISOString();
  const db = new DatabaseSync(input, { readOnly: true });
  let records = 0;
  let performances: PublicFallbackPerformance[];
  try {
    const check = db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('Backup integrity check failed.');
    records = Number(db.prepare('SELECT count(*) AS n FROM performances').get()!.n);
    // No joins: raw sources, bookmarks, notes and collection tables are never read.
    performances = db.prepare(`SELECT id,source,source_id,city_id,start_date,end_date,detail_state,data,updated_at
      FROM performances WHERE classification='performance' ORDER BY id`).all().map(project);
    if (!performances.length) throw new Error('The backup contains no public performances.');
    if (new Set(performances.map(item => item.id)).size !== performances.length) throw new Error('Duplicate public IDs.');
  } finally { db.close(); }
  if (inputSha256 !== sha256(readFileSync(input))) throw new Error('Source backup changed while exporting.');
  const snapshot: PublicFallbackSnapshot = { version: 1, snapshotAt, generatedAt: new Date().toISOString(), performances };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Public snapshot exceeds the decoded size budget.');
  const compressed = gzipSync(bytes, { level: 9 });
  if (compressed.length > 16 * 1024 * 1024) throw new Error('Public snapshot exceeds the compressed size budget.');
  if (!gunzipSync(compressed).equals(bytes)) throw new Error('Public snapshot compression verification failed.');
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, compressed, { flag: 'wx' }); renameSync(temporary, output); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  const sourceCounts: Record<Source, number> = { kopis: 0, culture: 0 };
  const detailCounts = { pending: 0, complete: 0, failed: 0 };
  for (const item of performances) { sourceCounts[item.source]++; detailCounts[item.detailState]++; }
  return { snapshotAt, generatedAt: snapshot.generatedAt, records, publicPerformances: performances.length,
    omittedNonPublic: records - performances.length, sourceCounts, detailCounts,
    citiesWithPerformances: new Set(performances.map(item => item.cityId)).size,
    venueCoordinates: performances.filter(item => item.locationPrecision === 'venue' && item.latitude !== undefined && item.longitude !== undefined).length,
    decodedBytes: bytes.length, compressedBytes: compressed.length, inputSha256, artifactSha256: sha256(compressed),
    sourceUnchanged: true, credentialPatternMatches: 0, privateFieldsExported: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 4) throw new Error('Usage: node --import tsx scripts/build-public-fallback.ts [backup.db] [output.json.gz]');
  console.log(JSON.stringify(buildPublicFallback({ input: process.argv[2], output: process.argv[3] }), null, 2));
}
