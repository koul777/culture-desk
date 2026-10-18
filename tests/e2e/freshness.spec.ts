import type { Performance } from '../../shared/types.js';
import { publishedFixture } from './fixture.js';
import { test, expect, expectTotal } from './helpers.js';

test('KST midnight refreshes status-filtered list and map once without changing the publication or chosen period', async ({ page }, testInfo) => {
  // Playwright's clock affects the browser only, not the Node fixture server.
  // Explicit before/after route oracles isolate the UI invalidation contract.
  const snapshotAt = publishedFixture.snapshotAt;
  const beforeTime = '2026-10-18T14:59:59.000Z', afterTime = '2026-10-18T15:00:01.000Z';
  let day = '2026-10-18', stage = 'initial';
  const reads = { bootstrap: 0, search: 0, map: 0 };
  const observed: { stage: string; endpoint: string; ids?: number[]; query?: Record<string, string> }[] = [];
  const bootIdentities: unknown[] = [];
  const row = (id: number, letter: string, startDate: string, endDate: string): Performance => ({
    ...publishedFixture.performances[0], id, sourceId: `TEST_DAY_${letter}`, title: `TEST 자정 공연 ${letter}`,
    venue: 'TEST 날짜 경계 공연장', startDate, endDate, latitude: 36.56, longitude: 128.72,
    bookmarked: false, note: '',
  });
  const all = [row(9901, 'A', '2026-10-18', '2026-10-18'), row(9902, 'B', '2026-10-19', '2026-10-20'),
    row(9903, 'C', '2026-10-17', '2026-10-20')];
  const selected = () => all.filter(item => item.startDate <= day && item.endDate >= day)
    .sort((a, b) => b.startDate.localeCompare(a.startDate) || b.id - a.id);
  const filters = { cities: ['andong'], from: '2026-10-01', to: '2026-11-30', genre: '', q: '', status: 'ongoing', price: '', age: '', source: '', limit: 30 };
  await page.clock.setFixedTime(new Date(beforeTime));
  await page.addInitScript(value => localStorage.setItem('culture-desk.filters.v3', JSON.stringify(value)), filters);
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), body = await response.json();
    body.today = day;
    body.sources = body.sources.map((source: { source: string }) => ({ ...source, count: source.source === 'kopis' ? 3 : 0 }));
    body.pendingDetails = 0;
    bootIdentities.push({ sources: body.sources, pendingDetails: body.pendingDetails, runs: body.runs,
      published: body.published, fallback: body.fallback ?? null });
    expect(body.published.snapshotAt).toBe(snapshotAt);
    if (stage !== 'initial') reads.bootstrap++;
    observed.push({ stage, endpoint: 'bootstrap' });
    await route.fulfill({ response, json: body });
  });
  for (const endpoint of ['performances', 'map'] as const) await page.route(`**/api/${endpoint}?**`, async route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    expect(query).toMatchObject({ cities: 'andong', from: filters.from, to: filters.to, status: 'ongoing' });
    const items = selected(), map = endpoint === 'map';
    if (stage !== 'initial') reads[map ? 'map' : 'search']++;
    observed.push({ stage, endpoint, ids: items.map(item => item.id), query });
    const markers = items.map(({ id, title, venue, cityId, startDate, endDate, latitude, longitude, locationPrecision, source }) =>
      ({ id, title, venue, cityId, startDate, endDate, latitude, longitude, locationPrecision, source }));
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
      'X-Culture-Data-Mode': 'published', 'X-Culture-Snapshot-At': snapshotAt },
    json: { items: map ? markers : items, total: 2, sourceCounts: { kopis: 2, culture: 0 }, pendingDetails: 0,
      partial: false, page: 1, pages: 1, snapshotAt, ...(map ? { truncated: false } : {}) } });
  });
  try {
    await page.goto('/#map');
    await expectTotal(page, 2);
    await expect(page.locator('.map-scope-note')).toContainText('검색 결과 2건');
    await expect(page.locator('.map-result-list h3')).toHaveText(['TEST 자정 공연 A', 'TEST 자정 공연 C']);
    await expect(page.locator('.venue-map-marker')).toHaveCount(1);
    expect(observed.filter(value => value.endpoint === 'map').at(-1)?.ids).toEqual([9901, 9903]);
    expect(await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()))).toBe('2026-10-18');

    day = '2026-10-19'; stage = 'midnight';
    await page.clock.setFixedTime(new Date(afterTime));
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await refreshed;
    await expect(page.locator('.workspace-bar')).toContainText('2026.10.19');
    await expect.poll(() => reads, { message: 'Only today changed; status-filtered list and map must each refresh once' })
      .toEqual({ bootstrap: 1, search: 1, map: 1 });
    expect(bootIdentities.at(-1)).toEqual(bootIdentities[0]);
    await expectTotal(page, 2);
    await expect(page.locator('.map-result-list h3')).toHaveText(['TEST 자정 공연 B', 'TEST 자정 공연 C']);
    expect(observed.filter(value => value.stage === 'midnight' && value.endpoint === 'map').at(-1)?.ids).toEqual([9902, 9903]);
    await expect(page.locator('.venue-map-marker')).toHaveCount(1);
    await page.locator('.venue-map-marker').click();
    await expect(page.locator('.leaflet-popup').getByRole('button', { name: 'TEST 자정 공연 B 상세 보기', exact: true })).toBeVisible();
    await expect(page.locator('.leaflet-popup').getByRole('button', { name: 'TEST 자정 공연 C 상세 보기', exact: true })).toBeVisible();
    await expect(page.locator('.leaflet-popup').getByRole('button', { name: 'TEST 자정 공연 A 상세 보기', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('빠른 조회 시작일', { exact: true })).toHaveValue(filters.from);
    await expect(page.getByLabel('빠른 조회 종료일', { exact: true })).toHaveValue(filters.to);
    await expect(page.locator('#search-filters input[type="radio"][value="ongoing"]')).toBeChecked();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('culture-desk.filters.v3')!))).toEqual(filters);

    stage = 'same-day';
    const repeated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await repeated;
    // Let React commit the refreshed bootstrap and run effects; a short observation
    // window checks absence of extra requests without advancing the minute poll.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.waitForTimeout(250);
    expect(reads).toEqual({ bootstrap: 2, search: 1, map: 1 });
    expect(observed.filter(value => value.stage === 'same-day' && value.endpoint !== 'bootstrap')).toEqual([]);
    expect(bootIdentities.at(-1)).toEqual(bootIdentities[0]);
  } finally {
    await testInfo.attach('kst-midnight-refresh.json', { contentType: 'application/json',
      body: JSON.stringify({ scope: 'Browser clock and explicit route fixture only; Node clock is unchanged.', beforeTime, afterTime,
        snapshotAt, filters, reads, bootIdentities, observed }, null, 2) });
  }
});
