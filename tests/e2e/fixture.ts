import { NATIONAL_CITIES } from '../../server/providers/cities.js';
import type { PublicReadonlySnapshot } from '../../server/cloud/readonly-fallback.js';

export const FIXTURE_DAY = '2026-10-18';
export const FIXTURE_TOTAL = 36;
const snapshotAt = `${FIXTURE_DAY}T00:30:00.000Z`;
type Row = PublicReadonlySnapshot['performances'][number];
const row = (id: number, changes: Partial<Row> = {}): Row => ({
  id, source: 'kopis', sourceId: `TEST_E2E_${id}`, title: `TEST 여수 정기 공연 ${String(id).padStart(2, '0')}`,
  cityId: 'yeosu', startDate: '2026-10-18', endDate: '2026-11-18', genre: '음악', sourceGenre: '음악',
  venue: 'TEST 가상 공연장', address: 'TEST 실제 공연이 아닌 자동 검증 자료', poster: '', sourceUrl: 'https://example.invalid/TEST',
  price: '30,000원', priceType: 'paid', age: '전체 관람가', runtime: '80분', cast: 'TEST 출연진', producer: 'TEST 제작',
  organizer: 'TEST 주최', contact: '', schedule: 'TEST 토요일 15:00', description: 'TEST 자동 검증 자료입니다. 실제 공연 정보가 아닙니다.',
  status: '', detailState: 'complete', classification: 'performance', reviewReason: '', updatedAt: snapshotAt,
  latitude: 34.76, longitude: 127.66, locationPrecision: 'venue', ...changes,
});

export const publishedFixture: PublicReadonlySnapshot = {
  version: 1, snapshotAt,
  refresh: { status: 'complete', day: FIXTURE_DAY, from: '2026-01-01', to: '2027-12-31',
    counts: { expectedRuns: 460, completeRuns: 460, totalTasks: 460, doneTasks: 460, remaining: 0, performances: FIXTURE_TOTAL },
    lastSuccessAt: snapshotAt, updatedAt: snapshotAt, error: null },
  coverage: { from: '2026-01-01', to: '2027-12-31', pairs: NATIONAL_CITIES.flatMap(city => [`kopis:${city.id}`, `culture:${city.id}`]) },
  performances: [
    row(1, { title: 'TEST 안동 무료 음악', cityId: 'andong', venue: 'TEST 안동 공연장', price: '무료', priceType: 'free',
      latitude: 36.56, longitude: 128.72,
      venueInfo: { facility: 'TEST 안동 공연장', halls: [{ name: 'TEST 대공연장', seats: 500 }], amenities: ['주차장'], booking: [] } }),
    row(2, { title: 'TEST 안동 유료 연극', cityId: 'andong', venue: 'TEST 안동 소극장', genre: '연극', sourceGenre: '연극',
      latitude: undefined, longitude: undefined, locationPrecision: 'city', source: 'culture' }),
    row(3, { title: 'TEST 강릉 유료 음악', cityId: 'gangneung', venue: 'TEST 강릉 공연장', latitude: 37.75, longitude: 128.9 }),
    ...Array.from({ length: FIXTURE_TOTAL - 3 }, (_, i) => row(i + 4)),
  ],
};
