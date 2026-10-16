import { checkedPerformance } from './validate.js';
import type { City, ListRequest, ListResponse, PerformanceInput, Provider } from '../../shared/types.js';
import { classifyCulture, inferPriceType, mergeReviewState, resolveCityId, cultureRegionParams } from './classify.js';
import { toIsoDate } from './dates.js';
import { ProviderError, assertNoSecrets } from './errors.js';
import { buildQueryString, fetchText, type HttpOptions } from './fetch.js';
import { safeText, safeUrl } from './text.js';
import { asArray, parseXmlDocument, readRecord } from './xml.js';
import { venueCoordinates } from './coordinates.js';

const CULTURE_BASE = 'https://apis.data.go.kr/B553457/cultureinfo';

export function createCultureProvider(apiKey: string, options: HttpOptions = {}): Provider {
  const key = apiKey.trim();
  return {
    source: 'culture',
    list: (request, signal) => listArea(key, request, signal, options),
    detail: (item, signal) => fetchDetail(key, item, signal, options),
  };
}

async function listArea(
  key: string,
  request: ListRequest,
  signal?: AbortSignal,
  options: HttpOptions = {},
): Promise<ListResponse> {
  const query = buildQueryString(
    {
      PageNo: request.page,
      numOfrows: Math.min(request.pageSize, 100),
      ...cultureRegionParams(request.city),
      from: request.from.replace(/-/g, ''),
      to: request.to.replace(/-/g, ''),
      serviceTp: 'A',
    },
    key,
  );
  const url = `${CULTURE_BASE}/area2?${query}`;
  const xml = await fetchText(url, signal, { ...options, apiKey: key });
  const { header, body } = parseCultureEnvelope(xml);
  if (header.code && header.code !== '00' && header.code !== '0') {
    throw mapCultureCode(header.code, header.message ?? '');
  }
  const rows = cultureRows(body);
  const items = rows.map((row) => checkedPerformance(mapCultureListRow(row, request.city, key), key));
  const total = Number(body.totalCount ?? 0);
  const pageSize = Math.min(request.pageSize, 100);
  const hasMore = total ? request.page * pageSize < total : rows.length >= pageSize;
  return { items, hasMore, total: total || undefined };
}

async function fetchDetail(
  key: string,
  item: PerformanceInput,
  signal?: AbortSignal,
  options: HttpOptions = {},
): Promise<PerformanceInput> {
  const seq = safeText(item.sourceId);
  const query = buildQueryString({ seq }, key);
  const url = `${CULTURE_BASE}/detail2?${query}`;
  const xml = await fetchText(url, signal, { ...options, apiKey: key });
  const { header, body } = parseCultureEnvelope(xml);
  if (header.code && header.code !== '00' && header.code !== '0') throw mapCultureCode(header.code, header.message ?? '');
  const row = cultureRows(body)[0];
  if (!row) throw new ProviderError('schema', 'culture detail missing');
  const mapped = checkedPerformance(mapCultureDetailRow(row, item.cityId, key), key);
  if (mapped.sourceId !== seq) throw new ProviderError('schema', 'detail identity mismatch');
  const merged = mergeReviewState(
    { classification: item.classification, reviewReason: item.reviewReason },
    { classification: mapped.classification, reviewReason: mapped.reviewReason },
  );
  return {
    ...item,
    ...mapped,
    classification: merged.classification,
    reviewReason: merged.reviewReason,
    detailState: 'complete',
  };
}

function parseCultureEnvelope(xml: string): { header: { code?: string; message?: string }; body: Record<string, any> } {
  const doc = parseXmlDocument(xml);
  const response = doc.response as { header?: Record<string, string>; body?: Record<string, unknown> } | undefined;
  if (!response?.header) throw new ProviderError('schema', 'culture response root invalid');
  const header = response.header;
  const parsedHeader = { code: safeText(header.resultCode), message: safeText(header.resultMsg) };
  if (parsedHeader.code && parsedHeader.code !== '00' && parsedHeader.code !== '0') {
    return { header: parsedHeader, body: {} };
  }
  if (!response.body) throw new ProviderError('schema', 'culture response body missing');
  return { header: parsedHeader, body: response.body as Record<string, any> };
}

function cultureRows(body: Record<string, unknown>): Record<string, string>[] {
  const items = body.items as { item?: unknown } | undefined;
  if (!items?.item) return [];
  return asArray(items.item).map((row) => readRecord(row));
}

function mapCultureCode(code: string, message: string): ProviderError {
  const msg = safeText(message);
  if (code === '30' || /key|인증|등록/i.test(msg)) return new ProviderError('auth', 'culture auth');
  if (code === '22' || /한도|limit|quota/i.test(msg)) return new ProviderError('quota', 'culture quota');
  return new ProviderError('schema', 'culture response error');
}

function mapCultureListRow(row: Record<string, string>, city: City, key: string): PerformanceInput {
  const sourceId = safeText(row.seq || row.Seq);
  const title = safeText(row.title || row.prfnm);
  const startDate = toIsoDate(row.startDate || row.startdate || row.eventStartDate);
  const endDate = toIsoDate(row.endDate || row.enddate || row.eventEndDate);
  const classed = classifyCulture({
    realmCode: row.realmCode || row.realmcode,
    realmName: row.realmName || row.realmname,
    serviceTp: row.serviceTp || row.servicetp || 'A',
    title,
  });
  const cityMatch = resolveCityId(city, {
    sigungu: row.sigungu,
    areaText: row.area || row.sido,
    address: row.gplace || row.placeAddr || row.area,
  });
  let classification = classed.classification;
  let reviewReason = classed.reviewReason;
  if (cityMatch.reviewReason && classification === 'performance') {
    classification = 'review';
    reviewReason = cityMatch.reviewReason;
  } else if (cityMatch.reviewReason && !reviewReason) {
    reviewReason = cityMatch.reviewReason;
    if (classification === 'performance') classification = 'review';
  }
  const raw = scrubRaw(row, key);
  assertNoSecrets(raw, key);
  return {
    source: 'culture',
    sourceId,
    title,
    cityId: cityMatch.cityId,
    startDate,
    endDate,
    genre: classed.genre,
    sourceGenre: classed.sourceGenre,
    venue: safeText(row.place),
    address: safeText(row.placeAddr || row.gplace || row.area),
    ...venueCoordinates(row.gpsY ?? row.gpsy, row.gpsX ?? row.gpsx),
    poster: safeUrl(row.imgUrl || row.thumbnail),
    sourceUrl: safeUrl(row.url || row.homepage),
    price: '',
    priceType: 'unknown',
    age: '',
    runtime: '',
    cast: '',
    producer: '',
    organizer: '',
    contact: '',
    schedule: '',
    description: safeText(row.contents1 || row.contents),
    status: '',
    detailState: 'pending',
    classification,
    reviewReason,
    raw,
  };
}

function mapCultureDetailRow(row: Record<string, string>, cityId: string, key: string): PerformanceInput {
  const sourceId = safeText(row.seq || row.Seq);
  const title = safeText(row.title || row.prfnm);
  const startDate = toIsoDate(row.startDate || row.startdate);
  const endDate = toIsoDate(row.endDate || row.enddate);
  const classed = classifyCulture({
    realmCode: row.realmCode || row.realmcode,
    realmName: row.realmName || row.realmname,
    serviceTp: row.serviceTp || row.servicetp || 'A',
    title,
  });
  const price = safeText(row.useFee || row.price || row.usetime);
  const description = safeText(row.contents1 || row.contents || row.subtitle);
  const raw = scrubRaw(row, key);
  assertNoSecrets(raw, key);
  return {
    source: 'culture',
    sourceId,
    title,
    cityId,
    startDate,
    endDate,
    genre: classed.genre,
    sourceGenre: classed.sourceGenre,
    venue: safeText(row.place),
    address: safeText(row.placeAddr || row.gplace || row.area),
    ...venueCoordinates(row.gpsY ?? row.gpsy, row.gpsX ?? row.gpsx),
    poster: safeUrl(row.imgUrl || row.thumbnail),
    sourceUrl: safeUrl(row.url || row.homepage),
    price,
    priceType: inferPriceType(price),
    age: safeText(row.agelimit || row.age),
    runtime: safeText(row.playtime),
    cast: safeText(row.actor),
    producer: safeText(row.program || row.sponsor1),
    organizer: safeText(row.sponsor1name || row.sponsor2name),
    contact: safeText(row.phone || row.tel || row.infocenter),
    schedule: safeText(row.usetime),
    description,
    status: '',
    detailState: 'complete',
    classification: classed.classification,
    reviewReason: classed.reviewReason,
    raw,
  };
}

function scrubRaw(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (/servicekey|service/i.test(k)) continue;
    if (typeof v === 'string' && v.includes(key)) continue;
    copy[k] = v;
  }
  return copy;
}
