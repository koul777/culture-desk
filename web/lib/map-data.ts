import type { MapPerformance } from '../../shared/types';

/** Retain source order and all performances at each coordinate, matching the existing map precision. */
export function groupVenueCoordinates(items: readonly MapPerformance[]): MapPerformance[][] {
  const groups = new Map<string, MapPerformance[]>();
  for (const item of items) {
    const key = `${item.latitude!.toFixed(5)},${item.longitude!.toFixed(5)}`;
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  return [...groups.values()];
}
