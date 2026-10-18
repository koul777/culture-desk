import type { MapPerformance } from '../../shared/types';

export const VENUE_POPUP_PAGE_SIZE = 20;
// Older/public snapshots can omit venue even though the regular API type requires it.
export type VenuePopupItem = Pick<MapPerformance, 'id' | 'title'> & { venue?: unknown };

/** Exact source strings, not inferred facilities or normalized hall names. */
export function venuePopupSummary(items: readonly VenuePopupItem[]) {
  const known = items.map(item => item.venue).filter((venue): venue is string => typeof venue === 'string' && !!venue.trim());
  const venueNames = [...new Set(known)], unknownVenueCount = items.length - known.length;
  return { venueNames, mixedVenues: venueNames.length > 1, unknownVenueCount,
    hasSingleVenue: venueNames.length === 1 && unknownVenueCount === 0, count: items.length };
}

function searchText(value: unknown): string { return typeof value === 'string' ? value.normalize('NFC').toLocaleLowerCase('ko-KR') : ''; }

/** Keep source ordering and identity; search does not mutate the map filter. */
export function filterVenuePopupItems<T extends VenuePopupItem>(items: readonly T[], query: string): readonly T[] {
  const term = searchText(query.trim());
  return term ? items.filter(item => searchText(item.title).includes(term) || searchText(item.venue).includes(term)) : items;
}

export function venuePopupPage<T extends VenuePopupItem>(items: readonly T[], query: string, requestedPage: number) {
  const matches = filterVenuePopupItems(items, query);
  const pages = Math.max(1, Math.ceil(matches.length / VENUE_POPUP_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1));
  const start = (page - 1) * VENUE_POPUP_PAGE_SIZE;
  return { matches, page, pages, items: matches.slice(start, start + VENUE_POPUP_PAGE_SIZE),
    total: matches.length, from: matches.length ? start + 1 : 0, to: Math.min(matches.length, start + VENUE_POPUP_PAGE_SIZE) };
}

/** External selection wins over a local query that would hide that performance. */
export function revealVenuePopupItem(items: readonly VenuePopupItem[], query: string, id: number) {
  if (!items.some(item => item.id === id)) return null;
  const matches = filterVenuePopupItems(items, query);
  const index = matches.findIndex(item => item.id === id);
  const visibleIndex = index >= 0 ? index : items.findIndex(item => item.id === id);
  return { query: index >= 0 ? query : '', page: Math.floor(visibleIndex / VENUE_POPUP_PAGE_SIZE) + 1 };
}
