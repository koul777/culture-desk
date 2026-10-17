import type { Performance } from '../../shared/types';

export interface DirectionLinks { kakao: string; naver: string; precise: boolean }

/**
 * Map apps use the visitor's own current location as the start point, so this site never asks for it.
 * Kakao routes to exact venue coordinates; without them both apps fall back to a place search.
 */
export function directionLinks(item: Pick<Performance, 'venue' | 'latitude' | 'longitude' | 'locationPrecision'> & { address?: string }): DirectionLinks | null {
  const venue = item.venue.trim(), address = item.address?.trim() || '';
  if (!venue && !address) return null;
  const precise = item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude);
  // Commas separate the name and coordinates in Kakao's route URL.
  const name = encodeURIComponent((venue || address).replace(/,/g, ' '));
  // Place search matches the facility, not "청주예술의전당 (대공연장)" or "예술의전당 [서울]".
  const place = venue.replace(/\s*\([^()]*\)\s*$/, '').replace(/[[\]]/g, '').trim() || venue;
  return {
    kakao: precise
      ? `https://map.kakao.com/link/to/${name},${item.latitude!.toFixed(6)},${item.longitude!.toFixed(6)}`
      : `https://map.kakao.com/link/search/${encodeURIComponent(address || venue)}`,
    naver: `https://map.naver.com/p/search/${encodeURIComponent(place || address)}`,
    precise,
  };
}
