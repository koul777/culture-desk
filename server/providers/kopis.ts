import { checkedPerformance } from './validate.js';
import type { City, ListRequest, ListResponse, PerformanceInput, Provider } from '../../shared/types.js';
import { classifyKopis, inferPriceType, mergeReviewState, resolveCityId } from './classify.js';
import { daysInclusive, toIsoDate, toKopisDate } from './dates.js';
import { ProviderError, assertNoSecrets } from './errors.js';
import { buildQueryString, fetchText, type HttpOptions } from './fetch.js';
import { safeText, safeUrl } from './text.js';
import { asArray, parseXmlDocument, readRecord } from './xml.js';
import { venueCoordinates, type VenueCoordinates } from './coordinates.js';

const KOPIS_BASE = 'https://www.kopis.or.kr/openApi/restful';

export function createKopisProvider(apiKey: string, options: HttpOptions = {}): Provider {
  const key = apiKey.trim();
  const facility = createFacilityReader(key, options);
  return {
    source: 'kopis',
    list: (request, signal) => listPerformances(key, request, signal, options),
    detail: (item, signal) => fetchDetail(key, item, facility, signal, options),
  };
}

async function listPerformances(
  key: string,
  request: ListRequest,
  signal?: AbortSignal,
  options: HttpOptions = {},
): Promise<ListResponse> {
  if (daysInclusive(request.from, request.to) > 31) {
    throw new ProviderError('schema', 'kopis date window exceeds 31 days');
  }
  const query = buildQueryString(
    {
      service: key,
      stdate: toKopisDate(request.from),
      eddate: toKopisDate(request.to),
      cpage: request.page,
      rows: Math.min(request.pageSize, 100),
      signgucode: request.city.kopisSido,
      signgucodesub: request.city.kopisSigungu,
    },
  );
  const url = `${KOPIS_BASE}/pblprfr?${query}`;
  const xml = await fetchText(url, signal, { ...options, apiKey: key });
  inspectKopisFault(xml);
  const doc = parseXmlDocument(xml);
  ensureKopisRoot(doc);
  const rows = kopisRows(doc);
  const items = rows.map((row) => checkedPerformance(mapKopisListRow(row, request.city, key), key));
  const hasMore = rows.length >= Math.min(request.pageSize, 100);
  return { items, hasMore };
}

async function fetchDetail(
  key: string,
  item: PerformanceInput,
  facility: FacilityReader,
  signal?: AbortSignal,
  options: HttpOptions = {},
): Promise<PerformanceInput> {
  const id = safeText(item.sourceId);
  const url = `${KOPIS_BASE}/pblprfr/${encodeURIComponent(id)}?service=${encodeURIComponent(key)}`;
  const xml = await fetchText(url, signal, { ...options, apiKey: key });
  inspectKopisFault(xml);
  const doc = parseXmlDocument(xml);
  ensureKopisRoot(doc);
  const row = kopisRows(doc)[0];
  if (!row) throw new ProviderError('schema', 'kopis detail missing');
  const mapped = checkedPerformance(mapKopisDetailRow(row, item.cityId, key), key);
  if (mapped.sourceId !== id) throw new ProviderError('schema', 'detail identity mismatch');
  const location = await facility(safeText(row.mt10id), signal);
  const merged = mergeReviewState(
    { classification: item.classification, reviewReason: item.reviewReason },
    { classification: mapped.classification, reviewReason: mapped.reviewReason },
  );
  return {
    ...item,
    ...mapped,
    ...(location?.coordinates ?? {}),
    address: location?.address || mapped.address,
    contact: location?.contact || mapped.contact,
    raw: location ? { ...(mapped.raw as Record<string, unknown>), facility: location.raw } : mapped.raw,
    classification: merged.classification,
    reviewReason: merged.reviewReason,
    detailState: 'complete',
  };
}

interface Facility {
  coordinates?: VenueCoordinates;
  address: string;
  contact: string;
  raw: Record<string, unknown>;
}
type FacilityReader = (id: string, signal?: AbortSignal) => Promise<Facility | undefined>;

/** Cache promises as well as completed results: performances sharing a venue use one request. */
function createFacilityReader(key: string, options: HttpOptions): FacilityReader {
  const cache = new Map<string, { expires: number; value: Promise<Facility | undefined> }>();
  return async (id, signal) => {
    if (!/^FC[\dA-Za-z-]+$/.test(id)) return;
    const cached = cache.get(id);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = (async (): Promise<Facility | undefined> => {
      try {
        const url = `${KOPIS_BASE}/prfplc/${encodeURIComponent(id)}?service=${encodeURIComponent(key)}`;
        const xml = await fetchText(url, signal, { ...options, apiKey: key });
        inspectKopisFault(xml);
        const doc = parseXmlDocument(xml);
        ensureKopisRoot(doc);
        const row = kopisRows(doc)[0];
        if (!row || safeText(row.mt10id) !== id) throw new ProviderError('schema', 'facility identity mismatch');
        const raw = scrubRaw(row, key);
        assertNoSecrets(raw, key);
        const result: Facility = {
          coordinates: venueCoordinates(row.la, row.lo),
          address: safeText(row.adres), contact: safeText(row.telno), raw,
        };
        assertNoSecrets(result, key);
        return result;
      } catch (error) {
        // Authentication/quota failures must still pause the source in the sync worker.
        // Optional location outages must not discard an otherwise valid performance detail.
        if (signal?.aborted || (error instanceof ProviderError && ['auth', 'quota'].includes(error.kind))) throw error;
        return undefined;
      }
    })();
    const entry = { expires: Date.now() + 60_000, value };
    cache.set(id, entry);
    try {
      const result = await value;
      if (result) entry.expires = Date.now() + 3_600_000;
      return result;
    } catch (error) {
      cache.delete(id);
      throw error;
    }
  };
}

function inspectKopisFault(xml: string): void {
  const lower = xml.toLowerCase();
  if (lower.includes('invalid') && lower.includes('key')) throw new ProviderError('auth', 'kopis auth');
  if (lower.includes('service key') && lower.includes('not')) throw new ProviderError('auth', 'kopis auth');
  if (lower.includes('openapi_error') || lower.includes('<error>')) {
    if (/limit|quota|too many|exceed/i.test(xml)) throw new ProviderError('quota', 'kopis quota');
    throw new ProviderError('schema', 'kopis error response');
  }
}

function mapKopisListRow(row: Record<string, string>, city: City, key: string): PerformanceInput {
  const sourceId = safeText(row.mt20id);
  const title = safeText(row.prfnm);
  const startDate = toIsoDate(row.prfpdfrom);
  const endDate = toIsoDate(row.prfpdto);
  const classed = classifyKopis({ shcate: row.shcate, genrenm: row.genrenm, festival: row.festival });
  const cityMatch = resolveCityId(city, { areaText: row.area, address: row.area }, { trustRegionFilter: true });
  const classification = cityMatch.reviewReason ? 'review' : classed.classification;
  const reviewReason = cityMatch.reviewReason || classed.reviewReason;
  const raw = scrubRaw(row, key);
  assertNoSecrets(raw, key);
  return {
    source: 'kopis',
    sourceId,
    title,
    cityId: cityMatch.cityId,
    startDate,
    endDate,
    genre: classed.genre,
    sourceGenre: classed.sourceGenre,
    venue: safeText(row.fcltynm),
    address: '',
    poster: safeUrl(row.poster),
    sourceUrl: sourceId ? `https://www.kopis.or.kr/por/db/pblprfr/pblprfrView.do?menuId=MNU_00020&mt20Id=${encodeURIComponent(sourceId)}` : '',
    price: '',
    priceType: 'unknown',
    age: '',
    runtime: '',
    cast: '',
    producer: '',
    organizer: '',
    contact: '',
    schedule: '',
    description: '',
    status: safeText(row.prfstate),
    detailState: 'pending',
    classification,
    reviewReason,
    raw,
  };
}

function mapKopisDetailRow(row: Record<string, string>, cityId: string, key: string): PerformanceInput {
  const sourceId = safeText(row.mt20id);
  const title = safeText(row.prfnm);
  const startDate = toIsoDate(row.prfpdfrom);
  const endDate = toIsoDate(row.prfpdto);
  const classed = classifyKopis({ shcate: row.shcate, genrenm: row.genrenm, festival: row.festival });
  const price = safeText(row.pcseguidance);
  const raw = scrubRaw(row, key);
  assertNoSecrets(raw, key);
  return {
    source: 'kopis',
    sourceId,
    title,
    cityId,
    startDate,
    endDate,
    genre: classed.genre,
    sourceGenre: classed.sourceGenre,
    venue: safeText(row.fcltynm),
    address: safeText(row.area),
    poster: safeUrl(row.poster),
    sourceUrl: sourceId ? `https://www.kopis.or.kr/por/db/pblprfr/pblprfrView.do?menuId=MNU_00020&mt20Id=${encodeURIComponent(sourceId)}` : '',
    price,
    priceType: inferPriceType(price),
    age: safeText(row.prfage),
    runtime: safeText(row.prfruntime),
    cast: safeText(row.prfcast),
    producer: safeText(row.entrpsnmP || row.entrpsnm),
    organizer: safeText(row.entrpsnmD || row.entrpsnmH || row.entrpsnmS),
    contact: '',
    schedule: safeText(row.dtguidance),
    description: safeText(row.sty),
    status: safeText(row.prfstate),
    detailState: 'complete',
    classification: classed.classification,
    reviewReason: classed.reviewReason,
    raw,
  };
}

function kopisRows(doc: Record<string, unknown>): Record<string, string>[] {
  const dbs = doc.dbs as { db?: unknown } | undefined;
  if (!dbs || dbs.db == null || dbs.db === '') return [];
  return asArray(dbs.db).map((row) => readRecord(row));
}

function ensureKopisRoot(doc: Record<string, unknown>): void {
  if (doc.response || doc.openapi_error) throw new ProviderError('schema', 'unexpected kopis root');
  if (!('dbs' in doc)) throw new ProviderError('schema', 'kopis root missing dbs');
}

function scrubRaw(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase().includes('service')) continue;
    const text = typeof v === 'string' ? v : v;
    if (typeof text === 'string' && text.includes(key)) continue;
    copy[k] = v;
  }
  return copy;
}
