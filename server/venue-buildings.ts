import type { Performance } from '../shared/types.js';
import { venueCoordinates } from './providers/coordinates.js';
import verifiedSeed from './venue-building-seed.json' with { type: 'json' };

// OSM specifications: https://wiki.openstreetmap.org/wiki/Overpass_API
// https://wiki.openstreetmap.org/wiki/Key:height / Key:building:levels
// Geometry is source data. A coordinate match is an association, not a verified venue identity.
type Position = [number, number];
type Ring = Position[];
type Polygon = Ring[];
export type VenueBuildingGeometry = { type: 'Polygon'; coordinates: Polygon } | { type: 'MultiPolygon'; coordinates: Polygon[] };
export type VenueBuilding = VenueBuildingGeometry & {
  heightMeters: number | null;
  heightSource: 'tag' | 'levels' | 'unknown';
  estimatedHeight: boolean;
  name: string;
  sourceUrl: string;
  osmType: 'way' | 'relation';
  osmId: number;
  confidence: 'coordinate_and_name' | 'coordinate' | 'name_nearby';
  matchMethod: 'contains_coordinate' | 'name_nearby';
  distanceMeters: number;
  nameSourceUrl?: string;
};
export interface VenueBuildingResponse {
  status: 'available' | 'unavailable';
  performanceId: number;
  source: 'OpenStreetMap';
  attribution: string;
  building: VenueBuilding | null;
  reason?: 'no_venue_coordinates' | 'no_matching_building' | 'ambiguous_match' | 'upstream_unavailable' | 'busy';
  message: string;
  checkedAt: string;
}
type VenueItem = Pick<Performance, 'id' | 'venue' | 'latitude' | 'longitude' | 'locationPrecision'>;
interface OsmPoint { lat: number; lon: number }
interface OsmMember { type: string; ref: number; role: string; geometry?: OsmPoint[] }
interface OsmElement { type: string; id: number; lat?: number; lon?: number; tags?: Record<string, string>; geometry?: OsmPoint[]; members?: OsmMember[] }
interface Candidate { element: OsmElement; geometry: VenueBuildingGeometry; polygons: Polygon[] }
type CachedResult = Omit<VenueBuildingResponse, 'performanceId'>;
const ATTRIBUTION = '© OpenStreetMap contributors · ODbL';
// Private.coffee explicitly permits applications. Do not use the overloaded FOSSGIS instance for this deployed app.
const ENDPOINTS = ['https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_LIMIT = 512;

function unavailable(reason: VenueBuildingResponse['reason'], message: string, now = Date.now()): CachedResult {
  return { status: 'unavailable', source: 'OpenStreetMap', attribution: ATTRIBUTION, building: null, reason, message, checkedAt: new Date(now).toISOString() };
}
function same(a: Position, b: Position) { return a[0] === b[0] && a[1] === b[1]; }
function points(raw: unknown): Ring | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3000) return null;
  const result: Ring = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object' || !venueCoordinates(p.lat, p.lon)) return null;
    result.push([Number(p.lon), Number(p.lat)]);
  }
  return result;
}
function signedArea(ring: Ring): number {
  let result = 0;
  for (let i = 1; i < ring.length; i++) result += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  return result / 2;
}
function orient(ring: Ring, outer: boolean): Ring { return (signedArea(ring) > 0) === outer ? ring : [...ring].reverse(); }
function validRing(ring: Ring): boolean {
  return ring.length >= 4 && ring.length <= 3000 && same(ring[0], ring[ring.length - 1]) && Math.abs(signedArea(ring)) > 1e-12;
}
function joinRings(segments: Ring[]): Ring[] | null {
  const pending = segments.map(ring => [...ring]);
  const rings: Ring[] = [];
  while (pending.length) {
    let ring = pending.shift()!;
    while (!same(ring[0], ring[ring.length - 1])) {
      const last = ring[ring.length - 1];
      const index = pending.findIndex(next => same(last, next[0]) || same(last, next[next.length - 1]));
      if (index < 0) return null;
      const next = pending.splice(index, 1)[0];
      if (!same(last, next[0])) next.reverse();
      ring = ring.concat(next.slice(1));
      if (ring.length > 3000) return null;
    }
    if (!validRing(ring)) return null;
    rings.push(ring);
  }
  return rings;
}
function insideRing(point: Position, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function segmentDistance(point: Position, a: Position, b: Position): number {
  const scaleX = 111320 * Math.cos(point[1] * Math.PI / 180), scaleY = 111320;
  const ax = (a[0] - point[0]) * scaleX, ay = (a[1] - point[1]) * scaleY;
  const bx = (b[0] - point[0]) * scaleX, by = (b[1] - point[1]) * scaleY;
  const dx = bx - ax, dy = by - ay, denominator = dx * dx + dy * dy;
  const t = denominator ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function ringDistance(point: Position, ring: Ring): number {
  let distance = Infinity;
  for (let i = 1; i < ring.length; i++) distance = Math.min(distance, segmentDistance(point, ring[i - 1], ring[i]));
  return distance;
}
function contains(point: Position, polygon: Polygon): boolean {
  return (insideRing(point, polygon[0]) || ringDistance(point, polygon[0]) < .05)
    && !polygon.slice(1).some(hole => insideRing(point, hole) || ringDistance(point, hole) < .05);
}
function candidate(element: OsmElement): Candidate | null {
  const tags = element.tags;
  if (!tags || typeof tags.building !== 'string' || ['no', 'demolished', 'razed', 'construction'].includes(tags.building)
    || tags.demolished === 'yes' || !Number.isSafeInteger(element.id) || element.id < 1) return null;
  let polygons: Polygon[];
  if (element.type === 'way') {
    const ring = points(element.geometry);
    if (!ring || !validRing(ring)) return null;
    polygons = [[orient(ring, true)]];
  } else if (element.type === 'relation' && tags.type === 'multipolygon') {
    if (!Array.isArray(element.members) || !element.members.length || element.members.length > 200) return null;
    const outer: Ring[] = [], inner: Ring[] = [];
    for (const member of element.members) {
      if (member.type !== 'way' || !['outer', 'inner', ''].includes(member.role)) return null;
      const ring = points(member.geometry); if (!ring) return null;
      (member.role === 'inner' ? inner : outer).push(ring);
    }
    const outerRings = joinRings(outer), innerRings = joinRings(inner);
    if (!outerRings?.length || !innerRings) return null;
    polygons = outerRings.map(ring => [orient(ring, true)]);
    for (const hole of innerRings) {
      const parents = polygons.filter(polygon => insideRing(hole[0], polygon[0]));
      if (parents.length !== 1) return null;
      parents[0].push(orient(hole, false));
    }
  } else return null;
  // Refuse campus-scale or corrupt outlines, rather than presenting them as one venue building.
  const all = polygons.flat(2);
  if (all.length > 12000) return null;
  const vertices = polygons.flat();
  for (const ring of vertices) {
    const lon = ring.map(p => p[0]), lat = ring.map(p => p[1]);
    if (Math.max(...lon) - Math.min(...lon) > .02 || Math.max(...lat) - Math.min(...lat) > .02) return null;
  }
  const geometry: VenueBuildingGeometry = polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
  return { element, polygons, geometry };
}
function normalizedName(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function namesMatch(venue: string, tags: Record<string, string>): boolean {
  const names = ['name', 'name:ko', 'official_name', 'alt_name', 'short_name'].flatMap(key => typeof tags[key] === 'string' ? tags[key].split(';') : []);
  const wanted = normalizedName(venue);
  return names.some(name => {
    const normalized = normalizedName(name);
    // Generic names such as 대극장 are not identity evidence for a different nearby building.
    return normalized.length >= 4 && !/^(대극장|소극장|공연장|문화회관|문예회관|예술회관|문화예술의전당|문화예술회관|아트홀|문화센터|시민회관|시청|대학교)$/.test(normalized)
      && (wanted === normalized || wanted.includes(normalized));
  });
}
export function buildingHeight(tags: Record<string, string>): Pick<VenueBuilding, 'heightMeters' | 'heightSource' | 'estimatedHeight'> {
  const raw = typeof tags.height === 'string' ? tags.height.trim() : '';
  let height: number | undefined;
  const metric = raw.match(/^(\d+(?:\.\d+)?)\s*(m|ft)?$/i);
  const imperial = raw.match(/^(\d+)'(?:(\d+(?:\.\d+)?)")?$/);
  if (metric) height = Number(metric[1]) * (metric[2]?.toLowerCase() === 'ft' ? .3048 : 1);
  else if (imperial) height = Number(imperial[1]) * .3048 + Number(imperial[2] ?? 0) * .0254;
  if (height !== undefined && height > 0 && height <= 1000) return { heightMeters: Math.round(height * 100) / 100, heightSource: 'tag', estimatedHeight: false };
  const levels = tags['building:levels'];
  if (typeof levels === 'string' && /^[1-9]\d{0,2}$/.test(levels) && Number(levels) <= 200)
    return { heightMeters: Number(levels) * 3, heightSource: 'levels', estimatedHeight: true };
  return { heightMeters: null, heightSource: 'unknown', estimatedHeight: false };
}

/** Pure, conservative association. A nearby building alone is never sufficient evidence. */
export function matchVenueBuilding(item: VenueItem, payload: unknown, now = Date.now()): CachedResult {
  const location = item.locationPrecision === 'venue' && venueCoordinates(item.latitude, item.longitude);
  if (!location) return unavailable('no_venue_coordinates', '공연장의 실제 좌표가 없어 건물을 확인할 수 없습니다.', now);
  const data = payload as { elements?: OsmElement[]; remark?: unknown } | null;
  if (!data || !Array.isArray(data.elements) || data.elements.length > 2000 || data.remark)
    return unavailable('upstream_unavailable', '건물 자료를 온전히 받지 못했습니다. 잠시 후 다시 확인하세요.', now);
  const candidates = data.elements.filter(element => element && typeof element === 'object').map(candidate).filter((c): c is Candidate => !!c);
  const relationWays = new Set(candidates.filter(c => c.element.type === 'relation').flatMap(c => c.element.members!.map(m => m.ref)));
  const point: Position = [location.longitude, location.latitude];
  const namedPoints = data.elements.filter(element => element.type === 'node' && element.tags
    && ['theatre', 'arts_centre', 'community_centre', 'events_venue', 'music_venue'].includes(element.tags.amenity)
    && venueCoordinates(element.lat, element.lon) && namesMatch(item.venue, element.tags)
    && segmentDistance(point, [element.lon!, element.lat!], [element.lon!, element.lat!]) <= 120);
  const matches = candidates.filter(c => c.element.type !== 'way' || !relationWays.has(c.element.id)).flatMap(c => {
    const contained = c.polygons.some(polygon => contains(point, polygon));
    const distance = contained ? 0 : Math.min(...c.polygons.flatMap(p => p.map(r => ringDistance(point, r))));
    const namePoint = namedPoints.find(node => c.polygons.some(polygon => contains([node.lon!, node.lat!], polygon)));
    const named = namesMatch(item.venue, c.element.tags!) || !!namePoint;
    const hasName = ['name', 'name:ko', 'official_name'].some(key => !!c.element.tags![key]);
    // A conflicting mapped building name is stronger evidence than a possibly misplaced source point.
    if ((!contained || hasName) && !named) return [];
    if (!contained && distance > 120) return [];
    return [{ ...c, contained, distance, named, namePoint, score: contained ? (named ? 3 : 2) : 1 }];
  }).sort((a, b) => b.score - a.score || a.distance - b.distance);
  if (!matches.length) return unavailable('no_matching_building', '공연장과 연결할 수 있는 실제 건물 도형을 찾지 못했습니다.', now);
  const best = matches[0], other = matches[1];
  if (other && other.score === best.score)
    return unavailable('ambiguous_match', '여러 건물이 같은 조건에 해당해 공연장 건물을 특정할 수 없습니다.', now);
  const tags = best.element.tags!;
  const building: VenueBuilding = {
    ...best.geometry, ...buildingHeight(tags), name: best.namePoint?.tags?.['name:ko'] || best.namePoint?.tags?.name || tags['name:ko'] || tags.name || '',
    osmType: best.element.type as 'way' | 'relation', osmId: best.element.id,
    sourceUrl: `https://www.openstreetmap.org/${best.element.type}/${best.element.id}`,
    confidence: best.contained ? (best.named ? 'coordinate_and_name' : 'coordinate') : 'name_nearby',
    matchMethod: best.contained ? 'contains_coordinate' : 'name_nearby', distanceMeters: Math.round(best.distance * 10) / 10,
    ...(best.namePoint ? { nameSourceUrl: `https://www.openstreetmap.org/node/${best.namePoint.id}` } : {}),
  };
  return { status: 'available', source: 'OpenStreetMap', attribution: ATTRIBUTION, building, checkedAt: new Date(now).toISOString(),
    message: building.confidence === 'coordinate' ? '공연장 좌표를 포함한 건물 도형입니다. 건물 이름은 확인되지 않았습니다.'
      : building.confidence === 'name_nearby' ? '공연장 주변에서 이름이 일치하는 건물 도형입니다.' : '공연장 좌표와 건물 이름이 일치하는 도형입니다.' };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw new Error('building response too large');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_BYTES) throw new Error('building response too large'); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => undefined); }
}

export class VenueBuildingService {
  private cache = new Map<string, { until: number; result: CachedResult }>();
  private pending = new Map<string, Promise<CachedResult>>();
  private cooling = new Map<string, number>();
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly endpoints: string[];
  constructor(options: { fetch?: typeof fetch; now?: () => number; endpoints?: string[] } = {}) {
    this.request = options.fetch ?? fetch; this.now = options.now ?? Date.now; this.endpoints = options.endpoints ?? ENDPOINTS;
  }
  async lookup(item: VenueItem): Promise<VenueBuildingResponse> {
    const location = item.locationPrecision === 'venue' && venueCoordinates(item.latitude, item.longitude);
    if (!location) return { ...unavailable('no_venue_coordinates', '공연장의 실제 좌표가 없어 건물을 확인할 수 없습니다.', this.now()), performanceId: item.id };
    // Small, attributed source snapshots verified at deployment. No fabricated polygons or heights.
    // Expiry prevents a historical snapshot silently being presented as indefinitely current.
    for (const seed of verifiedSeed.records) {
      const checked = Date.parse(seed.checkedAt);
      if (this.now() - checked > 30 * 86400000 || this.now() < checked) continue;
      if (Math.abs(seed.latitude - location.latitude) > .000001 || Math.abs(seed.longitude - location.longitude) > .000001) continue;
      const result = matchVenueBuilding(item, { elements: seed.elements }, checked);
      if (result.status === 'available') return { ...result, performanceId: item.id };
    }
    const key = `${location.latitude.toFixed(7)},${location.longitude.toFixed(7)}:${normalizedName(item.venue)}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now()) return { ...cached.result, performanceId: item.id };
    let promise = this.pending.get(key);
    if (!promise) {
      // Per warm process: bounded concurrency and bounded cache. Edge caching is supplied by the route.
      if (this.pending.size >= 2) return { ...unavailable('busy', '다른 건물 자료를 확인 중입니다. 잠시 후 다시 시도하세요.', this.now()), performanceId: item.id };
      promise = this.load(item).then(result => {
        const ttl = result.status === 'available' ? 24 * 3600000 : ['upstream_unavailable', 'busy'].includes(result.reason ?? '') ? 30000 : 6 * 3600000;
        this.cache.delete(key); this.cache.set(key, { until: this.now() + ttl, result });
        while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
        return result;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, promise);
    }
    return { ...await promise, performanceId: item.id };
  }
  private async load(item: VenueItem): Promise<CachedResult> {
    const lat = item.latitude!.toFixed(7), lon = item.longitude!.toFixed(7);
    const query = `[out:json][timeout:8][maxsize:16777216];(way["building"](around:250,${lat},${lon});relation["building"](around:250,${lat},${lon});node["name"]["amenity"~"^(theatre|arts_centre|community_centre|events_venue|music_venue)$"](around:250,${lat},${lon}););out body geom;`;
    for (const endpoint of this.endpoints) {
      if ((this.cooling.get(endpoint) ?? 0) > this.now()) continue;
      try {
        const url = new URL(endpoint); url.searchParams.set('data', query);
        const response = await this.request(url, { headers: { Accept: 'application/json', 'User-Agent': 'CultureDesk/1.0 venue-building-lookup (OpenStreetMap attribution retained)' }, signal: AbortSignal.timeout(10000) });
        if ([429, 406].includes(response.status)) this.cooling.set(endpoint, this.now() + 30000);
        if (!response.ok) { await response.body?.cancel(); continue; }
        const result = matchVenueBuilding(item, await boundedJson(response), this.now());
        if (result.reason !== 'upstream_unavailable') return result;
      } catch { /* Provider/network details must not become a public error or break performance browsing. */ }
    }
    return unavailable('upstream_unavailable', '건물 제공처에 연결하지 못했습니다. 잠시 후 다시 확인하세요.', this.now());
  }
}
