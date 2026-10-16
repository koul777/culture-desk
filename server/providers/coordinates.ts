export interface VenueCoordinates {
  latitude: number;
  longitude: number;
  locationPrecision: 'venue';
}

/** Accept actual source coordinates only. Empty, null, swapped axes and overseas points are absent. */
export function venueCoordinates(latitude: unknown, longitude: unknown): VenueCoordinates | undefined {
  const lat = coordinateNumber(latitude);
  const lng = coordinateNumber(longitude);
  if (lat === undefined || lng === undefined || lat < 33 || lat > 39 || lng < 124 || lng > 132) return;
  return { latitude: lat, longitude: lng, locationPrecision: 'venue' };
}

function coordinateNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  if (typeof value === 'string' && !value.trim()) return;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
