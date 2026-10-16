import type { Classification, City, Genre, PriceType } from '../../shared/types.js';
import { safeText } from './text.js';

export interface ClassificationResult {
  classification: Classification;
  genre: Genre;
  sourceGenre: string;
  reviewReason: string;
}

const KOPIS_GENRE: Record<string, Genre> = {
  AAAA: '연극',
  GGGA: '뮤지컬',
  CCCA: '음악',
  CCCD: '음악',
  CCCC: '국악',
  BBBC: '무용',
  BBBE: '무용',
  EEEA: '복합공연',
  EEEB: '기타',
};

const KOPIS_GENRE_NAME: Record<string, Genre> = {
  연극: '연극',
  뮤지컬: '뮤지컬',
  '서양음악(클래식)': '음악',
  '한국음악(국악)': '국악',
  대중음악: '음악',
  '무용(서양/한국무용)': '무용',
  대중무용: '무용',
  '서커스/마술': '기타',
  복합: '복합공연',
};

const CULTURE_REALM: Record<string, Genre> = {
  A000: '연극',
  B003: '뮤지컬',
  B000: '음악',
  B002: '국악',
  C000: '무용',
};

const CULTURE_REALM_NAME: Record<string, Genre> = {
  연극: '연극',
  '음악/콘서트': '음악',
  국악: '국악',
  '무용/발레': '무용',
  '뮤지컬/오페라': '뮤지컬',
};

const CULTURE_EXCLUDED_REALM = new Set(['D000']);
const CULTURE_EXCLUDED_SERVICE = new Set(['C']);
const CULTURE_REVIEW_REALM = new Set(['E000', 'F000', 'L000', 'H000', 'I000']);

export function classifyKopis(fields: { shcate?: string; genrenm?: string; festival?: string }): ClassificationResult {
  const code = safeText(fields.shcate).toUpperCase();
  const name = safeText(fields.genrenm);
  const genre = KOPIS_GENRE[code] ?? KOPIS_GENRE_NAME[name] ?? '기타';
  if (!code && !name) {
    return { classification: 'review', genre: '기타', sourceGenre: name, reviewReason: '장르 정보 없음' };
  }
  if (safeText(fields.festival).toUpperCase() === 'Y' && genre === '기타') {
    return { classification: 'review', genre, sourceGenre: name || code, reviewReason: '축제 분류 — 공연 내용 확인 필요' };
  }
  if (!KOPIS_GENRE[code] && !KOPIS_GENRE_NAME[name]) {
    return { classification: 'review', genre, sourceGenre: name || code, reviewReason: '허용 목록에 없는 KOPIS 장르' };
  }
  return { classification: 'performance', genre, sourceGenre: name || code, reviewReason: '' };
}

export function classifyCulture(fields: {
  realmCode?: string;
  realmName?: string;
  serviceTp?: string;
  title?: string;
}): ClassificationResult {
  const realmCode = safeText(fields.realmCode).toUpperCase();
  const realmName = safeText(fields.realmName);
  const serviceTp = safeText(fields.serviceTp).toUpperCase();
  const sourceGenre = realmName || realmCode;

  if (CULTURE_EXCLUDED_REALM.has(realmCode) || /전시/.test(realmName)) {
    return { classification: 'excluded', genre: '기타', sourceGenre, reviewReason: '전시 분류' };
  }
  if (CULTURE_EXCLUDED_SERVICE.has(serviceTp) || /교육|체험/.test(realmName)) {
    return { classification: 'excluded', genre: '기타', sourceGenre, reviewReason: '교육·체험 분류' };
  }
  if (!realmCode && !realmName) {
    return { classification: 'review', genre: '기타', sourceGenre, reviewReason: '분류 누락' };
  }
  const genre = CULTURE_REALM[realmCode] ?? CULTURE_REALM_NAME[realmName] ?? '기타';
  if (CULTURE_REVIEW_REALM.has(realmCode) || genre === '기타') {
    return {
      classification: 'review',
      genre,
      sourceGenre,
      reviewReason: realmCode === 'F000' ? '행사·축제 — 공연 내용 확인 필요' : '불명확한 문화포털 분류',
    };
  }
  return { classification: 'performance', genre, sourceGenre, reviewReason: '' };
}

export function resolveCityId(
  city: City,
  hints: { sigungu?: string; areaText?: string; address?: string },
  options: { trustRegionFilter?: boolean } = {},
): { cityId: string; reviewReason: string } {
  const trustRegionFilter = options.trustRegionFilter ?? true;
  const responseSigungu = safeText(hints.sigungu);
  // Sejong has no lower municipality: Culture splits its records into 세종시, 조치원읍, etc.
  // Only accept these subdivisions when the source explicitly identifies Sejong itself.
  if (city.kopisSido === '36' && city.sido === '세종특별자치시') {
    const area = safeText(hints.areaText);
    const address = safeText(hints.address);
    const sejongArea = /^(세종|세종시|세종특별자치시)$/.test(area);
    if (area && !sejongArea) return { cityId: city.id, reviewReason: '응답 시도가 수집 도시와 다름' };
    if (sejongArea
      || /^(세종특별자치시|세종시)\s/.test(address)
      || /^(세종|세종시|세종특별자치시)$/.test(responseSigungu)) return { cityId: city.id, reviewReason: '' };
  }
  if (responseSigungu) {
    if (responseSigungu === city.sigungu || responseSigungu.includes(city.sigungu)) {
      return { cityId: city.id, reviewReason: '' };
    }
    return { cityId: city.id, reviewReason: '응답 시군구가 수집 도시와 다름' };
  }
  const blob = [hints.areaText, hints.address].map(safeText).filter(Boolean).join(' ');
  if (!blob) return { cityId: city.id, reviewReason: trustRegionFilter ? '' : '지역 확인 정보 없음' };
  if (blob.includes(city.sigungu)) return { cityId: city.id, reviewReason: '' };
  const provinceNames = [city.sido, provinceShortName(city.sido), ...(city.sido === '전남광주통합특별시'
    ? ['전남광주', '전라남도', '전남', '광주광역시'] : [])].sort((a,b) => b.length-a.length);
  const municipalityText = provinceNames.reduce((text,name) => text.replaceAll(name,' '),blob);
  // A province match cannot override evidence of a different municipality.
  // Remove province names first: the 시 in 특별시 is not a city mismatch.
  if (/(?:^|\s)[가-힣]+(?:시|군|구)(?:\s|$)/.test(municipalityText)) {
    return { cityId: city.id, reviewReason: '응답 주소가 수집 도시와 다름' };
  }
  if (provinceNames.some(name => blob.includes(name))) {
    return { cityId: city.id, reviewReason: trustRegionFilter ? '' : '광역 지역만 확인됨' };
  }
  return { cityId: city.id, reviewReason: '응답 주소가 수집 도시와 다름' };
}

export function inferPriceType(price: string): PriceType {
  const text = safeText(price);
  if (!text) return 'unknown';
  const amounts = [...text.matchAll(/(\d+(?:,\d{3})*)\s*원/g)].map((m) => Number(m[1].replace(/,/g, '')));
  if (amounts.length) {
    if (amounts.every((n) => n === 0)) return 'free';
    if (amounts.some((n) => n > 0)) return 'paid';
  }
  if (/무료|free/i.test(text)) return 'free';
  if (/\d/.test(text)) return 'paid';
  return 'unknown';
}

export function provinceShortName(sido: string): string {
  const names: Record<string,string> = {
    서울특별시:'서울', 부산광역시:'부산', 대구광역시:'대구', 인천광역시:'인천', 광주광역시:'광주',
    대전광역시:'대전', 울산광역시:'울산', 세종특별자치시:'세종', 경기도:'경기',
    강원도:'강원', 강원특별자치도:'강원', 충청북도:'충북', 충청남도:'충남',
    전라북도:'전북', 전북특별자치도:'전북', 전라남도:'전남', 경상북도:'경북', 경상남도:'경남', 제주특별자치도:'제주',
    // Live area2 responses use 광주 + 여수시/순천시 for the merged province (verified 2026-10-16).
    전남광주통합특별시:'광주',
  };
  return names[sido] ?? sido;
}

export function cultureRegionParams(city: City): { sido: string; sigungu?: string } {
  return { sido: provinceShortName(city.sido), sigungu: city.kopisSido === '36' ? undefined : city.sigungu };
}

export function mergeReviewState(
  previous: { classification: Classification; reviewReason: string },
  next: { classification: Classification; reviewReason: string },
): { classification: Classification; reviewReason: string } {
  if (previous.classification === 'review' && previous.reviewReason) {
    if (next.classification === 'performance' && !next.reviewReason) {
      return previous;
    }
  }
  if (previous.classification === 'excluded') return previous;
  return next;
}
