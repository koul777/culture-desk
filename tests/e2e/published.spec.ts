import ExcelJS from 'exceljs';
import type { APIResponse, Route } from '@playwright/test';
import { test, expect, openPublished, expectTotal, selectAndong } from './helpers.js';

async function fulfillCancelledResponse(route: Route, response: APIResponse, unexpected: string[]) {
  try { await route.fulfill({ response }); }
  catch (error) {
    // A detached interception can reject after this exact request was aborted.
    // Preserve unrelated protocol/programming failures instead of hiding them.
    const cancelled = route.request().failure()?.errorText === 'net::ERR_ABORTED';
    if (!cancelled || !/net::ERR_ABORTED|Invalid InterceptionId|Request is already disposed/i.test(String(error))) unexpected.push(String(error));
  }
}

test('published search, cards, table, map, detail and export share the same regional results', async ({ page }, testInfo) => {
  await openPublished(page);
  await expect(page.locator('.performance-card')).toHaveCount(30);
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
  await expect(page.locator('.performance-card')).toHaveCount(6);
  await expect(page.getByRole('navigation', { name: '검색 결과 페이지' })).toContainText('2 / 2 페이지');
  await selectAndong(page); // A new filter also resets page 2 back to page 1.
  const titles = ['TEST 안동 무료 음악', 'TEST 안동 유료 연극'];
  const cardTitles = page.locator('.performance-card h3');
  expect((await cardTitles.allTextContents()).sort()).toEqual(titles);
  await page.screenshot({ path: testInfo.outputPath('desktop-cards.png'), fullPage: true });

  await page.getByRole('button', { name: 'TEST 안동 무료 음악', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'TEST 안동 무료 음악' });
  await expect(detail.getByText('TEST 출연진', { exact: true })).toBeVisible();
  await expect(detail.getByText('TEST 대공연장', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: '상세 정보 가져오기', exact: true })).toHaveCount(0);
  await detail.getByRole('button', { name: '닫기', exact: true }).click();

  await page.getByRole('button', { name: '표', exact: true }).click();
  await expect(page.locator('.search-table tbody tr')).toHaveCount(2);
  expect((await page.locator('.search-table tbody th').allTextContents()).sort()).toEqual(titles);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '엑셀 내보내기', exact: true }).click();
  const download = await downloadPromise;
  const workbookPath = testInfo.outputPath('regional-results.xlsx');
  await download.saveAs(workbookPath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const rows = workbook.getWorksheet('공연 목록')!;
  expect(rows.rowCount).toBe(3);
  expect([rows.getCell('B2').text, rows.getCell('B3').text].sort()).toEqual(titles);
  const evidence = workbook.getWorksheet('조회 근거')!;
  expect(evidence.getCell('B3').text).toContain('andong');

  const mapResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/map');
  await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  const map = await (await mapResponse).json();
  expect(map.total).toBe(2);
  expect(map.items.map((item: { title: string }) => item.title).sort()).toEqual(titles);
  await expect(page.getByText('공연장 위치 1건 · 위치 미확인 1건', { exact: true })).toBeVisible();
  await expect(page.locator('.map-result-list .performance-card')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('desktop-map.png'), fullPage: true });

  await page.getByRole('button', { name: /^상세 조건/ }).click();
  await page.getByRole('combobox', { name: /^관람료/ }).selectOption('free');
  await expectTotal(page, 1);
  await expect(page.locator('.map-result-list h3')).toHaveText('TEST 안동 무료 음악');
});

test('obsolete searches are aborted and cannot replace the newest result', async ({ page }, testInfo) => {
  await openPublished(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const intercepted = new Promise<void>(resolve => { started = resolve; });
  const cancelled: string[] = [];
  const routeErrors: string[] = [];
  let settled = false;
  page.on('requestfailed', request => { if (new URL(request.url()).searchParams.get('q') === '안동') cancelled.push(request.failure()?.errorText ?? ''); });
  await page.route('**/api/performances?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') !== '안동') return route.fallback();
    try {
      const response = await route.fetch();
      started();
      await held;
      await fulfillCancelledResponse(route, response, routeErrors);
    } finally { settled = true; }
  });
  try {
    await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('안동');
    await intercepted;
    await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('강릉');
    await expectTotal(page, 1);
    await expect(page.locator('.performance-card h3')).toHaveText('TEST 강릉 유료 음악');
    await expect.poll(() => cancelled.length).toBeGreaterThan(0);
  } finally {
    release();
    await expect.poll(() => settled, { message: 'released obsolete search route must finish before final UI assertions' }).toBe(true);
    await testInfo.attach('held-search-settlement.json', { body: JSON.stringify({ settled, cancelled, routeErrors }, null, 2), contentType: 'application/json' });
  }
  expect(routeErrors).toEqual([]);
  await expect(page.getByText('검색 결과를 불러오지 못했습니다', { exact: true })).toHaveCount(0);
  await expect(page.locator('.performance-card h3')).toHaveText('TEST 강릉 유료 음악');
});

test('search failure retries cleanly and restores the requested result', async ({ page }) => {
  await openPublished(page);
  let attempts = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/performances?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') !== '강릉') return route.fallback();
    if (++attempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"TEST temporary failure"}' });
    await held;
    return route.fallback();
  });
  await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('강릉');
  await expect(page.getByText('검색 결과를 불러오지 못했습니다', { exact: true })).toBeVisible();
  try {
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByText('검색 결과를 불러오지 못했습니다', { exact: true })).toHaveCount(0);
    await expect(page.locator('.results')).toHaveAttribute('aria-busy', 'true');
  } finally { release(); }
  await expectTotal(page, 1);
  await expect(page.locator('.performance-card h3')).toHaveText('TEST 강릉 유료 음악');
  expect(attempts).toBe(2);
});

test('map exit cancels its request and reentry works when external tiles fail', async ({ page }, testInfo) => {
  await openPublished(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const intercepted = new Promise<void>(resolve => { started = resolve; });
  let first = true;
  const cancelled: string[] = [];
  const routeErrors: string[] = [];
  let settled = false;
  page.on('requestfailed', request => { if (new URL(request.url()).pathname === '/api/map') cancelled.push(request.failure()?.errorText ?? ''); });
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 503, body: 'TEST tile outage' }));
  await page.route('**/api/map?**', async route => {
    if (!first) return route.fallback();
    first = false;
    try {
      const response = await route.fetch(); started();
      await held;
      await fulfillCancelledResponse(route, response, routeErrors);
    } finally { settled = true; }
  });
  try {
    await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
    await intercepted;
    await page.getByRole('button', { name: '카드', exact: true }).click();
    await expect(page.locator('.performance-grid .performance-card')).toHaveCount(30);
    await expect.poll(() => cancelled.length).toBeGreaterThan(0);
  } finally {
    release();
    await expect.poll(() => settled, { message: 'released obsolete map route must finish before reentry' }).toBe(true);
    await testInfo.attach('held-map-settlement.json', { body: JSON.stringify({ settled, cancelled, routeErrors }, null, 2), contentType: 'application/json' });
  }
  expect(routeErrors).toEqual([]);
  await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  await expect(page.locator('.map-scope-note')).toContainText('검색 결과 36건');
  await expect(page.getByText('지도 배경을 불러오지 못했습니다. 공연 마커와 목록은 계속 이용할 수 있습니다.', { exact: true })).toBeVisible();
  await expect(page.locator('.map-result-list .performance-card')).toHaveCount(30);
  await page.getByRole('button', { name: 'TEST 여수 정기 공연 36', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'TEST 여수 정기 공연 36' })).toBeVisible();
});

test('region dialog supports keyboard dismissal and restores focus', async ({ page }) => {
  await openPublished(page);
  const trigger = page.getByRole('button', { name: /^지역 선택/ }).first();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '전국 지역 선택' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('dialog[open] :focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expectTotal(page, 36);
});

for (const extension of ['js', 'css']) {
  test(`map ${extension} chunk failure offers reload and restores a styled map with saved filters`, async ({ page }) => {
    let blocked = true;
    const failedRequests: string[] = [], restoredRequests: string[] = [];
    await page.route(new RegExp(`/assets/PerformanceMap-[^/]+\\.${extension}$`), route => {
      if (blocked) {
        failedRequests.push(route.request().url());
        return route.abort('failed');
      }
      restoredRequests.push(route.request().url());
      return route.fallback(); // Keep the shared offline/runtime guard active.
    });
    await openPublished(page);
    const search = page.getByRole('searchbox', { name: '공연명·공연장 검색' });
    await search.fill('안동');
    await expectTotal(page, 2);
    await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
    const alert = page.locator('.map-module-state [role="alert"]');
    await expect(alert).toContainText('지도를 불러오지 못했습니다');
    await expect(page.locator('.leaflet-container')).toHaveCount(0);
    expect(failedRequests.length, 'the selected chunk was actually blocked').toBeGreaterThan(0);
    blocked = false;
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await alert.getByRole('button', { name: '페이지 새로고침', exact: true }).click();
    await navigation;
    await expect(page).toHaveURL(/#map$/);
    await expect(search).toHaveValue('안동');
    await expectTotal(page, 2);
    await expect(page.locator('.map-scope-note')).toContainText('검색 결과 2건');
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await expect(page.locator('.leaflet-pane').first()).toHaveCSS('position', 'absolute');
    await expect.poll(() => page.locator('link[rel="stylesheet"]').evaluateAll(links => {
      const mapStyles = links.filter(link => /PerformanceMap-/.test((link as HTMLLinkElement).href));
      return mapStyles.length > 0 && mapStyles.every(link => !!(link as HTMLLinkElement).sheet);
    }), { message: 'the actual lazy map stylesheet loaded after reload' }).toBe(true);
    expect(restoredRequests.length, 'reload retried the restored chunk URL').toBeGreaterThan(0);
    await expect(alert).toHaveCount(0);
  });
}

test('low-zoom keyboard popup keeps final focus through resize and returns it on Escape', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__CULTURE_PERFORMANCE__ = true; });
  await openPublished(page);
  await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  await expect(page.locator('.map-scope-note')).toContainText('검색 결과 36건');
  await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('TEST 안동 무료 음악');
  await expectTotal(page, 1);
  await expect(page.locator('.map-scope-note')).toContainText('검색 결과 1건');
  const marker = page.locator('.venue-map-marker');
  await expect(marker).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => {
    const ready = performance.getEntriesByName('culture:map-ready').filter(entry => {
      const detail = (entry as PerformanceMark).detail;
      return detail?.dataSource === 'map' && detail?.count === 1;
    }).at(-1) as PerformanceMark | undefined;
    return ready?.detail?.zoom ?? 99;
  }), { message: 'national bounds exercise the low-zoom marker replacement path' }).toBeLessThan(14);
  expect(await page.evaluate(() => performance.getEntriesByName('culture:map-popup').length)).toBe(0);
  const originalMarker = await marker.elementHandle();
  await marker.focus();
  await page.keyboard.press('Enter');
  const popupButton = page.locator('.map-popup-show');
  await expect(popupButton).toHaveCount(1);
  await expect(popupButton).toBeFocused();
  expect(await originalMarker!.evaluate(element => element.isConnected), 'low-zoom marker was replaced').toBe(false);
  await originalMarker!.dispose();
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await expect(popupButton).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.leaflet-popup')).toHaveCount(0);
  await expect(page.locator('.venue-map-marker:focus')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(popupButton).toHaveCount(1);
  await expect(popupButton).toBeFocused();
  expect(await page.evaluate(() => performance.getEntriesByName('culture:map-popup').length), 'reopening the same marker reuses its popup DOM').toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.venue-map-marker:focus')).toHaveCount(1);
});

test('a newer publication with unchanged counts refreshes both list and map once', async ({ page }, testInfo) => {
  let updated = false, originalSnapshotAt = '', nextSnapshotAt = '';
  let originalCounts: unknown, newCounts: unknown;
  const reads = { bootstrap: 0, search: 0, map: 0 };
  const updatedTitle = 'TEST 안동 새 공개 음악';
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch(), body = await response.json();
    const counts = { sources: body.sources.map((source: { source: string; count: number }) => [source.source, source.count]), pendingDetails: body.pendingDetails, runs: body.runs };
    if (!updated) {
      originalSnapshotAt = body.published.snapshotAt; originalCounts = counts;
    } else {
      reads.bootstrap++; newCounts = counts;
      body.published.snapshotAt = nextSnapshotAt;
    }
    await route.fulfill({ response, json: body });
  });
  for (const endpoint of ['performances', 'map'] as const) await page.route(`**/api/${endpoint}?**`, async route => {
    if (!updated) return route.fallback();
    reads[endpoint === 'map' ? 'map' : 'search']++;
    const response = await route.fetch(), body = await response.json();
    body.items = body.items.map((item: { id: number; title: string }) => item.id === 1 ? { ...item, title: updatedTitle } : item);
    body.snapshotAt = nextSnapshotAt;
    if (body.published) body.published.snapshotAt = nextSnapshotAt;
    await route.fulfill({ response, json: body });
  });
  await openPublished(page);
  await selectAndong(page);
  await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  await expect(page.locator('.map-scope-note')).toContainText('검색 결과 2건');
  await expect(page.locator('.map-result-list h3')).toContainText(['TEST 안동 유료 연극', 'TEST 안동 무료 음악']);
  nextSnapshotAt = new Date(Date.parse(originalSnapshotAt) + 60_000).toISOString();
  updated = true;
  try {
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap');
    // Use the real visibility-refresh path rather than waiting for the minute poll.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await refreshed;
    await expect.poll(() => reads, { message: 'new publication identity must invalidate list and full-map data exactly once' }).toEqual({ bootstrap: 1, search: 1, map: 1 });
    expect(newCounts).toEqual(originalCounts);
    await expectTotal(page, 2);
    await expect(page.locator('.map-result-list h3')).toContainText(['TEST 안동 유료 연극', updatedTitle]);
    await page.locator('.venue-map-marker').click();
    await expect(page.locator('.leaflet-popup').getByRole('button', { name: `${updatedTitle} 상세 보기`, exact: true })).toBeVisible();
    expect(reads).toEqual({ bootstrap: 1, search: 1, map: 1 });
  } finally {
    await testInfo.attach('publication-refresh.json', { body: JSON.stringify({ originalSnapshotAt, nextSnapshotAt, originalCounts, newCounts, reads }, null, 2), contentType: 'application/json' });
  }
});
