import type { MapPerformance, MapResult, SearchResult } from '../shared/types.js';
import type { SearchPerformanceTrace } from './search-performance.js';
import { MAP_MAX_BYTES, MAP_MAX_ITEMS } from './map-limits.js';

export { MAP_MAX_BYTES, MAP_MAX_ITEMS } from './map-limits.js';

function marker(item: MapPerformance): MapPerformance {
  return {
    id: item.id, title: item.title, venue: item.venue, cityId: item.cityId,
    startDate: item.startDate, endDate: item.endDate,
    latitude: item.latitude, longitude: item.longitude, locationPrecision: item.locationPrecision,
    source: item.source,
  };
}

/** Preserve complete titles/venues and budget the full UTF-8 envelope, including separators. */
export function buildMapResult(result: Omit<SearchResult, 'items'> & { items: MapPerformance[] }, trace?: SearchPerformanceTrace): MapResult {
  const response: MapResult = { ...result, items: [], truncated: false };
  let projectionMs = 0, budgetMs = 0;
  const project = trace ? (item: MapPerformance) => {
    const started = performance.now();
    const value = marker(item);
    projectionMs += performance.now() - started;
    return value;
  } : marker;
  const byteLength = trace ? (value: unknown) => {
    const started = performance.now();
    const bytes = Buffer.byteLength(JSON.stringify(value));
    budgetMs += performance.now() - started;
    return bytes;
  } : (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  let bytes = byteLength(response);
  for (const item of result.items) {
    if (response.items.length >= MAP_MAX_ITEMS) break;
    const value = project(item);
    const extra = byteLength(value) + (response.items.length ? 1 : 0);
    if (bytes + extra > MAP_MAX_BYTES) break;
    response.items.push(value); bytes += extra;
  }
  response.truncated = response.items.length < result.items.length;
  if (trace) {
    trace({ phase: 'map.project', durationMs: projectionMs, rows: response.items.length });
    trace({ phase: 'map.budget', durationMs: budgetMs, bytes });
  }
  return response;
}
