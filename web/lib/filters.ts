import type { Bootstrap, PriceType, SearchFilters, Source } from '../../shared/types';
import { GENRES, addYears, defaultPeriod, isIsoDate } from './format';

export interface FilterState {
  cities: string[]; from: string; to: string; genre: string; q: string;
  status: '' | 'upcoming' | 'ongoing' | 'ended'; price: '' | PriceType; age: string;
  source: '' | Source; limit: number;
}

export const PAGE_SIZES = [30, 50, 100];
// v1 restored the old seven-city default. Start the new nationwide search cleanly.
const STORAGE_KEY = 'culture-desk.filters.v3';
const PREVIOUS_STORAGE_KEY = 'culture-desk.filters.v2';

export function defaultFilters(boot: Bootstrap): FilterState {
  return {
    cities: [], ...defaultPeriod(boot.today),
    genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30,
  };
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

/** Filters are only a convenience: anything stale or malformed falls back to the defaults. */
export function loadFilters(boot: Bootstrap): FilterState {
  const base = defaultFilters(boot);
  let saved: Record<string, unknown> | null = null;
  let migrate = false;
  try {
    let raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) { raw = window.localStorage.getItem(PREVIOUS_STORAGE_KEY); migrate = !!raw; }
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch { saved = null; }
  if (!saved) return base;
  const known = new Set(boot.cities.map(c => c.id));
  const cities = Array.isArray(saved.cities) ? saved.cities.filter((id): id is string => typeof id === 'string' && known.has(id)) : [];
  const from = migrate && saved.from === addYears(boot.today, -1) ? base.from : typeof saved.from === 'string' && isIsoDate(saved.from) ? saved.from : base.from;
  const to = typeof saved.to === 'string' && isIsoDate(saved.to) ? saved.to : base.to;
  const limit = typeof saved.limit === 'number' && PAGE_SIZES.includes(saved.limit) ? saved.limit : base.limit;
  return {
    cities: cities.length ? [...new Set(cities)] : base.cities,
    ...(from <= to ? { from, to } : { from: base.from, to: base.to }),
    genre: oneOf(saved.genre, ['', ...GENRES], ''),
    q: text(saved.q, 200),
    status: oneOf(saved.status, ['', 'upcoming', 'ongoing', 'ended'] as const, ''),
    price: oneOf(saved.price, ['', 'free', 'paid', 'unknown'] as const, ''),
    age: text(saved.age, 50),
    source: oneOf(saved.source, ['', 'kopis', 'culture'] as const, ''),
    limit,
  };
}

export function saveFilters(filters: FilterState): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filters)); } catch { /* storage unavailable: filters stay in memory */ }
}

export function toSearchFilters(f: FilterState, page?: number): SearchFilters {
  const out: SearchFilters = {
    cities: f.cities.join(','), from: f.from, to: f.to, genre: f.genre, q: f.q.trim(),
    status: f.status, price: f.price, age: f.age.trim(), source: f.source,
  };
  if (page !== undefined) { out.page = String(page); out.limit = String(f.limit); }
  return out;
}

export const usesDetailFilter = (f: Pick<FilterState, 'price' | 'age'>) => !!f.price || !!f.age.trim();

export function filterProblem(f: FilterState): string | null {
  if (!isIsoDate(f.from) || !isIsoDate(f.to)) return '조회 기간의 시작일과 종료일을 입력하세요.';
  if (f.from > f.to) return '시작일이 종료일보다 늦습니다. 기간을 다시 선택하세요.';
  return null;
}
