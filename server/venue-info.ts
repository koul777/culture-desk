import type { VenueHall, VenueInfo } from '../shared/types.js';
import { safeText } from './providers/text.js';

type Fields = Record<string, unknown>;
/** KOPIS facility flags. Only 'Y' is shown: 'N' also covers facilities the provider did not report. */
const AMENITIES = [
  ['parkinglot', '주차장'], ['elevbarrier', '장애인 엘리베이터'], ['runwbarrier', '장애인 경사로'], ['restbarrier', '장애인 화장실'],
  ['parkbarrier', '장애인 주차'], ['suyu', '수유실'], ['nolibang', '놀이방'], ['cafe', '카페'], ['restaurant', '식당'], ['store', '편의점'],
] as const;
const AMENITY_LABELS = new Set<string>(AMENITIES.map(([, label]) => label));

const fields = (value: unknown): Fields | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
const rows = (value: unknown): Fields[] => (Array.isArray(value) ? value : [value]).map(fields).filter((row): row is Fields => !!row);
const text = (value: unknown, max = 120): string => typeof value === 'string' ? safeText(value).replace(/\s+/g, ' ').slice(0, max) : '';
const count = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : /^\d{1,6}$/.test(text(value)) ? Number(text(value)) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n < 1_000_000 ? n : undefined;
};
function link(value: unknown): string | undefined {
  const raw = text(value, 500);
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
const hallKey = (name: string) => name.replace(/[\s()[\]·.,\-]/g, '').toLowerCase();

/** Marks the hall named in a KOPIS venue such as "예술의전당 [서울] 오페라극장"; a single-hall facility is always current. */
function markCurrent(halls: VenueHall[], facility: string, venue: string): VenueHall[] {
  if (halls.length === 1) return [{ ...halls[0], current: true }];
  const target = hallKey(venue), facilityKey = hallKey(facility);
  const match = halls.map(hall => hallKey(hall.name))
    .filter(key => key.length >= 2 && key !== facilityKey && target.includes(key))
    .sort((a, b) => b.length - a.length)[0];
  return halls.map(hall => match && hallKey(hall.name) === match ? { ...hall, current: true } : hall);
}

/** Validates a derived or stored value. Unknown keys and malformed entries are dropped, never passed through. */
export function cleanVenueInfo(value: unknown, venue: string): VenueInfo | undefined {
  const source = fields(value);
  if (!source) return;
  const facility = text(source.facility);
  const halls = rows(source.halls).slice(0, 20).flatMap((row): VenueHall[] => {
    const name = text(row.name);
    if (!name) return [];
    const hall: VenueHall = { name };
    const seats = count(row.seats), disabledSeats = count(row.disabledSeats), stageArea = text(row.stageArea, 40);
    if (seats) hall.seats = seats;
    if (disabledSeats) hall.disabledSeats = disabledSeats;
    if (stageArea) hall.stageArea = stageArea;
    return [hall];
  });
  const amenities = (Array.isArray(source.amenities) ? source.amenities : []).filter((label): label is string => typeof label === 'string' && AMENITY_LABELS.has(label));
  const seen = new Set<string>();
  const booking = rows(source.booking).flatMap(row => {
    const name = text(row.name, 40), url = link(row.url);
    if (!name || !url || seen.has(url)) return [];
    seen.add(url);
    return [{ name, url }];
  }).slice(0, 10);
  const info: VenueInfo = { facility, halls: markCurrent(halls, facility, venue), amenities: [...new Set(amenities)], booking };
  const seats = count(source.seats), homepage = link(source.homepage);
  if (seats) info.seats = seats;
  if (homepage) info.homepage = homepage;
  return info.halls.length || info.seats || info.homepage || info.booking.length || info.amenities.length ? info : undefined;
}

/** KOPIS stores the facility response under raw.facility and booking sites under raw.relates.relate. */
export function venueInfoFromSource(raw: unknown, venue: string): VenueInfo | undefined {
  const source = fields(raw), facility = fields(source?.facility);
  if (!source || (!facility && !source.relates)) return;
  return cleanVenueInfo({
    facility: facility?.fcltynm,
    seats: facility?.seatscale,
    halls: rows(fields(facility?.mt13s)?.mt13).map(hall => ({
      name: hall.prfplcnm, seats: hall.seatscale, disabledSeats: hall.disabledseatscale, stageArea: hall.stagearea,
    })),
    amenities: facility ? AMENITIES.filter(([key]) => facility[key] === 'Y').map(([, label]) => label) : [],
    homepage: facility?.relateurl,
    booking: rows(fields(source.relates)?.relate).map(relate => ({ name: relate.relatenm, url: relate.relateurl })),
  }, venue);
}
