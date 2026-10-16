import type { Bootstrap, Genre, Performance, PriceType, Source, SyncRun, SyncState } from '../../shared/types';

export const GENRES: Genre[] = ['연극', '뮤지컬', '음악', '국악', '무용', '복합공연', '기타'];
export const SOURCES: Source[] = ['kopis', 'culture'];
export const SOURCE_LABEL: Record<Source, string> = { kopis: 'KOPIS', culture: '문화포털' };
export const PRICE_LABEL: Record<PriceType, string> = { free: '무료', paid: '유료', unknown: '정보 미상' };
export const STATUS_LABEL = { upcoming: '예정', ongoing: '진행 중', ended: '종료' } as const;
export type ShowStatus = keyof typeof STATUS_LABEL;

/** Collection states as the plan names them: 미연결 / 미수집 / 수집 중 / 일부 실패 / 한도 대기 / 중단 / 완료. */
export const RUN_LABEL: Record<SyncState, string> = {
  queued: '수집 대기', running: '수집 중', partial: '일부 실패', quota_wait: '한도 대기', paused: '중단', complete: '완료',
};
export const ACTIVE_STATES: SyncState[] = ['queued', 'running'];
export const isActive = (run: SyncRun) => ACTIVE_STATES.includes(run.state);
export const canPause = (run: SyncRun) => run.state === 'queued' || run.state === 'running';
export const canResume = (run: SyncRun) => run.state === 'paused' || run.state === 'partial' || run.state === 'quota_wait';

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
export const RUN_TONE: Record<SyncState, Tone> = {
  queued: 'accent', running: 'accent', partial: 'danger', quota_wait: 'warn', paused: 'neutral', complete: 'ok',
};

export function sourceLabel(boot: Bootstrap | null, source: Source): string {
  return boot?.sources.find(s => s.source === source)?.label || SOURCE_LABEL[source];
}

export function cityName(boot: Bootstrap | null, id: string): string {
  const city=boot?.cities.find(c=>c.id===id);
  if(!city) return id;
  if(!boot!.cities.some(c=>c.id!==id&&c.name===city.name)) return city.name;
  const province:Record<string,string>={서울특별시:'서울',부산광역시:'부산',대구광역시:'대구',인천광역시:'인천',대전광역시:'대전',울산광역시:'울산',전남광주통합특별시:'전남광주',경기도:'경기',강원특별자치도:'강원',충청북도:'충북',충청남도:'충남',전북특별자치도:'전북',경상북도:'경북',경상남도:'경남',제주특별자치도:'제주'};
  return `${province[city.sido]||city.sido} ${city.name}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isIsoDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === value;
}

function shift(value: string, years: number, months: number, days = 0): string {
  const [y, m, d] = value.split('-').map(Number);
  const target = new Date(Date.UTC(y + years, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay) + days);
  return target.toISOString().slice(0, 10);
}
export const addYears = (value: string, n: number) => shift(value, n, 0);
export const addMonths = (value: string, n: number) => shift(value, 0, n);
export const addDays = (value: string, n: number) => shift(value, 0, 0, n);

export interface PeriodPreset { id: string; label: string; hint: string; range: (today: string) => { from: string; to: string } }
export const PERIOD_PRESETS: PeriodPreset[] = [
  { id: 'default', label: '전체 공연', hint: '이번 달 ~ 향후 3개월', range: t => ({ from: `${t.slice(0, 7)}-01`, to: addMonths(t, 3) }) },
  { id: 'past', label: '과거 사례', hint: '최근 1년', range: t => ({ from: addYears(t, -1), to: t }) },
  { id: 'upcoming', label: '예정 공연', hint: '오늘 ~ 향후 3개월', range: t => ({ from: t, to: addMonths(t, 3) }) },
];
export const defaultPeriod = (today: string) => PERIOD_PRESETS[0].range(today);

/** Same 31-day split the server uses for KOPIS list requests. */
export function chunkCount(from: string, to: string, size = 31): number {
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) return 0;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return Math.ceil(days / size);
}

export function formatDate(value: string): string {
  return isIsoDate(value) ? value.replaceAll('-', '.') : value || '날짜 미상';
}
export function formatPeriod(start: string, end: string): string {
  if (!start && !end) return '기간 미상';
  if (start === end || !end) return formatDate(start);
  return `${formatDate(start)} – ${formatDate(end)}`;
}

const dateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '기록 없음';
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : dateTime.format(new Date(t));
}

export function showStatus(p: Pick<Performance, 'startDate' | 'endDate'>, today: string): ShowStatus | null {
  if (!isIsoDate(p.startDate) || !isIsoDate(p.endDate || p.startDate)) return null;
  if (p.startDate > today) return 'upcoming';
  if ((p.endDate || p.startDate) < today) return 'ended';
  return 'ongoing';
}

export const number = (n: number) => n.toLocaleString('ko-KR');

/** Detail-dependent value: distinguishes "not collected yet" from "collected but the source has no value". */
export function detailValue(p: Performance, value: string): { text: string; missing: boolean } {
  if (value.trim()) return { text: value, missing: false };
  if (p.detailState === 'pending') return { text: '상세 미수집', missing: true };
  if (p.detailState === 'failed') return { text: '상세 수집 실패', missing: true };
  return { text: '정보 미상', missing: true };
}

/** 관람료 원문 우선. 값이 없으면 상세 미수집·수집 실패·정보 미상을 구분하고, 빈 값을 무료로 보지 않는다. */
export function priceSummary(p: Performance): { text: string; tag: string | null; missing: boolean } {
  if (p.price.trim()) return { text: p.price, tag: p.priceType === 'unknown' ? null : PRICE_LABEL[p.priceType], missing: false };
  if (p.priceType === 'free') return { text: '무료', tag: null, missing: false };
  if (p.priceType === 'paid') return { text: '유료 · 금액 원문 없음', tag: null, missing: false };
  if (p.detailState === 'pending') return { text: '상세 미수집', tag: null, missing: true };
  if (p.detailState === 'failed') return { text: '상세 수집 실패', tag: null, missing: true };
  return { text: '정보 미상', tag: null, missing: true };
}

export function genreText(p: Pick<Performance, 'genre' | 'sourceGenre'>): { main: string; sub: string } {
  const source = p.sourceGenre.trim();
  if (p.genre === '기타' && !source) return { main: '장르 미상', sub: '' };
  return { main: p.genre, sub: source && source !== p.genre ? `원문: ${source}` : '' };
}

/** Only http(s) links from providers are rendered as links or images. */
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}
