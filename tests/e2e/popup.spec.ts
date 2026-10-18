import type { MapPerformance } from '../../shared/types.js';
import { test, expect, openPublished } from './helpers.js';

// A narrow Chromium viewport is required: the old locate flow could focus a row
// above the screen while its desktop layout happened to keep that row visible.
test.use({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });

test('375px dense popup keeps local navigation and reveals repeated external locate requests', async ({ page }, testInfo) => {
  let ordered: MapPerformance[] = [];
  const requests = { map: 0, search: 0 };
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/map') requests.map++;
    if (path === '/api/performances') requests.search++;
  });
  await page.route('**/api/map?**', async route => {
    const response = await route.fetch();
    const body = await response.json();
    // This test alone puts existing TEST IDs at one synthetic coordinate.
    // Original titles, venue strings, ordering, fixture totals and detail IDs stay intact.
    ordered = body.items.map((item: MapPerformance) => ({ ...item, latitude: 34.76, longitude: 127.66, locationPrecision: 'venue' }));
    await route.fulfill({ response, json: { ...body, items: ordered } });
  });
  await openPublished(page);
  const targetTitle = await page.locator('.performance-card h3').last().textContent();
  await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  const marker = page.locator('.venue-map-marker');
  await expect(page.locator('.map-scope-note')).toContainText('검색 결과 36건');
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute('data-performance-count', '36');
  expect(ordered).toHaveLength(36);
  const targetIndex = ordered.findIndex(item => item.title === targetTitle), target = ordered[targetIndex];
  expect(targetIndex).toBeGreaterThanOrEqual(20);
  await expect(marker).toHaveAccessibleName(/^이 위치의 공연 36건 · 공연장 표기/);
  await marker.click();
  const popup = page.locator('.map-popup'), shows = popup.locator('.map-popup-show');
  const search = popup.getByRole('searchbox', { name: '이 위치의 공연명·공연장 검색', exact: true });
  const next = popup.getByRole('button', { name: '이 위치의 공연 다음 페이지', exact: true });
  const ids = () => shows.evaluateAll(elements => elements.map(element => Number((element as HTMLElement).dataset.performanceId)));
  const state = () => popup.evaluate(element => ({
    query: element.querySelector<HTMLInputElement>('input')!.value,
    page: element.querySelector('.map-popup-page')!.textContent,
    ids: [...element.querySelectorAll<HTMLElement>('.map-popup-show')].map(row => Number(row.dataset.performanceId)),
  }));
  await expect(shows).toHaveCount(20);
  expect(await ids()).toEqual(ordered.slice(0, 20).map(item => item.id));
  await expect(popup.locator('.map-popup-3d,.map-popup-route')).toHaveCount(0);
  expect(await popup.locator('.map-popup-venue').allTextContents()).toEqual(ordered.slice(0, 20).map(item => item.venue));
  const initialRequests = { ...requests };
  const firstIds = await ids();
  await next.click(); await expect(shows).toHaveCount(16); await expect(shows.first()).toBeFocused();
  expect([...firstIds, ...await ids()]).toEqual(ordered.map(item => item.id));
  await expect(next).toBeDisabled();

  const preserved: unknown[] = [];
  for (const localState of ['page2', 'title', 'empty']) for (const method of ['keyboard', 'pointer']) {
    await search.fill('reset-local-test'); await search.fill('');
    if (localState === 'page2') { await next.click(); await expect(shows.first()).toBeFocused(); }
    else await search.fill(localState === 'title' ? ordered[0].title : '없는 공연장 TEST xyz');
    if (localState === 'empty') { await expect(shows).toHaveCount(0); await expect(popup.locator('[role="status"]')).toContainText('검색 결과 0건'); }
    const before = await state();
    await search.focus(); await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0); await expect(marker).toBeFocused();
    if (method === 'keyboard') await page.keyboard.press('Enter'); else await marker.click();
    await expect(popup).toBeVisible();
    await expect.poll(state).toEqual(before);
    if (method === 'keyboard') {
      if (localState === 'empty') await expect(search).toBeFocused();
      else await expect.poll(() => shows.evaluateAll(elements => elements.some(element => element === document.activeElement))).toBe(true);
    }
    preserved.push({ localState, method, before, after: await state() });
  }

  const locate = page.locator('.map-result-list .card-locate').last();
  const targetRow = popup.locator(`[data-performance-id="${target.id}"]`);
  const visibleFraction = () => targetRow.evaluate(element => {
    const row = element.getBoundingClientRect(), scroll = element.closest('.leaflet-popup-content')!.getBoundingClientRect();
    let top = window.visualViewport?.offsetTop ?? 0;
    const bottom = top + (window.visualViewport?.height ?? window.innerHeight);
    const header = document.querySelector<HTMLElement>('.sidebar');
    if (header) {
      const bounds = header.getBoundingClientRect(), position = getComputedStyle(header).position;
      if (['fixed', 'sticky'].includes(position) && bounds.top <= top + 1 && bounds.left < row.right && bounds.right > row.left) top = Math.max(top, bounds.bottom);
    }
    return Math.max(0, Math.min(row.bottom, scroll.bottom, bottom) - Math.max(row.top, scroll.top, top)) / row.height;
  });
  await locate.click(); await expect(targetRow).toBeFocused();
  await expect.poll(visibleFraction).toBeGreaterThan(.99);
  await expect(search).toHaveValue(''); await expect(popup.locator('.map-popup-page')).toHaveText('2 / 2');
  // A fresh local query hides this already-selected ID; same-ID locate must still work.
  await search.fill('없는 공연장 TEST xyz'); await expect(shows).toHaveCount(0);
  await locate.click(); await expect(targetRow).toBeFocused();
  await expect.poll(visibleFraction).toBeGreaterThan(.99);
  await expect(search).toHaveValue(''); await expect(popup.locator('.map-popup-page')).toHaveText('2 / 2');
  expect(requests).toEqual(initialRequests);
  await testInfo.attach('popup-local-state.json', { body: JSON.stringify({ orderedIds: ordered.map(item => item.id), targetId: target.id, preserved, requests }, null, 2), contentType: 'application/json' });
});

test('cached popup state survives visiting another marker and zooming within venue view', async ({ page }) => {
  // This desktop retention flow uses visible map zoom controls. The separate
  // narrow test above protects mobile external-locate viewport visibility.
  await page.setViewportSize({ width: 1440, height: 1000 });
  let ordered: MapPerformance[] = [];
  await page.route('**/api/map?**', async route => {
    const response = await route.fetch(), body = await response.json();
    ordered = body.items;
    const items = ordered.map((item, index) => ({ ...item, latitude: 34.76 + (index === 35 ? .0015 : 0), longitude: 127.66 + (index === 35 ? .0015 : 0), locationPrecision: 'venue' }));
    await route.fulfill({ response, json: { ...body, items } });
  });
  await openPublished(page);
  await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  await expect(page.locator('.map-scope-note')).toContainText('검색 결과 36건');
  await page.locator('.map-result-list .card-locate').first().click();
  const marker = page.locator('.venue-map-marker[data-performance-count="35"]'), sibling = page.locator('.venue-map-marker[data-performance-count="1"]');
  await expect(marker).toHaveCount(1); await expect(sibling).toHaveCount(1);
  const popup = page.locator('.map-popup'), search = popup.locator('input');
  const next = popup.getByRole('button', { name: '이 위치의 공연 다음 페이지', exact: true });
  const state = () => popup.evaluate(element => ({ query: element.querySelector<HTMLInputElement>('input')!.value,
    page: element.querySelector('.map-popup-page')!.textContent,
    ids: [...element.querySelectorAll<HTMLElement>('.map-popup-show')].map(row => row.dataset.performanceId) }));
  for (const local of ['query', 'page2']) for (const method of ['pointer', 'keyboard']) {
    await search.fill('reset-local'); await search.fill('');
    if (local === 'query') await search.fill(ordered[34].title); else await next.click();
    const expected = await state();
    await search.focus(); await page.keyboard.press('Escape'); await sibling.click();
    await popup.locator('.map-popup-show').first().focus(); await page.keyboard.press('Escape');
    if (method === 'pointer') await marker.click(); else { await marker.focus(); await page.keyboard.press('Enter'); }
    await expect.poll(state).toEqual(expected);
  }
  await search.fill('reset-local'); await search.fill(''); await next.click();
  const expected = await state(), inputNode = await search.elementHandle(), markerNode = await marker.elementHandle();
  await page.locator('.leaflet-control-zoom-in').click();
  await expect(popup).toBeVisible(); await expect.poll(state).toEqual(expected);
  expect(await inputNode!.evaluate(element => element.isConnected && element === document.querySelector('.map-popup-search input'))).toBe(true);
  expect(await markerNode!.evaluate(element => element.isConnected && element === document.querySelector('.venue-map-marker[data-performance-count="35"]'))).toBe(true);
  await inputNode?.dispose(); await markerNode?.dispose();
});

test('new focus intent cancels queued popup row focus while layout updates preserve it', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  let mapFixture: unknown;
  await page.route('**/api/map?**', async route => {
    const response = await route.fetch(), body = await response.json();
    expect(body.items).toHaveLength(36);
    // This controller-only map response is separate from the unchanged36-row
    // search fixture. Keep all36 original IDs/order and add5 synthetic map rows.
    // Page2 must not be the final page: disabling the clicked Next button would
    // introduce a different native blur before the queued-focus race is tested.
    const extra = body.items.slice(0, 5).map((item: MapPerformance, index: number) => ({ ...item, id: 1_000_000 + index, title: `SYNTHETIC FOCUS ROW ${index + 1}` }));
    const items = [...body.items, ...extra].map((item: MapPerformance) => ({ ...item, latitude: 34.76, longitude: 127.66, locationPrecision: 'venue' }));
    const originalIds = body.items.map((item: MapPerformance) => item.id), ids = items.map(item => item.id);
    expect(items).toHaveLength(41); expect(new Set(ids).size).toBe(41); expect(ids.slice(0, 36)).toEqual(originalIds);
    const sourceCounts: Record<string, number> = Object.fromEntries(Object.keys(body.sourceCounts).map(source => [source, 0]));
    for (const item of items) sourceCounts[item.source] = (sourceCounts[item.source] ?? 0) + 1;
    expect(Object.values(sourceCounts).reduce((total, count) => total + count, 0)).toBe(41);
    mapFixture = { originalIds, ids, total: items.length, sourceCounts };
    await route.fulfill({ response, json: { ...body, total: items.length, page: 1, pages: 1, sourceCounts, truncated: false, items } });
  });
  await openPublished(page);
  await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  const marker = page.locator('.venue-map-marker[data-performance-count="41"]');
  await marker.focus(); await page.keyboard.press('Enter');
  const popup = page.locator('.map-popup'), search = popup.locator('input'), rows = popup.locator('.map-popup-show');
  await expect(rows.first()).toBeFocused();
  const next = popup.getByRole('button', { name: '이 위치의 공연 다음 페이지', exact: true });
  const externalSearch = page.getByRole('searchbox', { name: '공연명·공연장 검색', exact: true });
  const results: unknown[] = [];
  for (const intent of ['tab', 'external-search', 'layout']) {
    await search.fill('reset-local'); await search.fill(''); await next.focus();
    try {
      const captured = await page.evaluate(() => {
        const nativeFrame = window.requestAnimationFrame, nativeCancel = window.cancelAnimationFrame;
        const frames = new Map<number, FrameRequestCallback>(), held = new Set<number>(); let sequence = 1_000_000_000;
        const cleanup = () => { frames.clear(); window.requestAnimationFrame = nativeFrame; window.cancelAnimationFrame = nativeCancel; delete (window as any).__popupFocusTest; };
        (window as any).__popupFocusTest = { cleanup, release: () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(performance.now())); return batch.length; } };
        window.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); held.add(id); return id; };
        window.cancelAnimationFrame = id => { if (held.has(id)) frames.delete(id); else nativeCancel.call(window, id); };
        // Delay only frames scheduled synchronously by this one button activation.
        // Restore normal RAF before genuine Tab/click/resize input begins.
        try { document.querySelector<HTMLButtonElement>('.map-popup-pagination button:last-child')!.click(); }
        finally { window.requestAnimationFrame = nativeFrame; }
        return frames.size;
      });
      expect(captured, 'exactly the controller focus frame is held').toBe(1);
      await expect(popup.locator('.map-popup-page')).toHaveText('2 / 3');
      await expect(next).toBeEnabled();
      await expect(next).toBeFocused();
      if (intent === 'tab') {
        await page.keyboard.press('Tab'); await expect(page.locator('.leaflet-popup-close-button')).toBeFocused();
      } else if (intent === 'external-search') {
        await externalSearch.click(); await expect(externalSearch).toBeFocused();
      } else {
        await page.setViewportSize({ width: 1441, height: 1000 });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(next).toBeFocused();
      }
      const released = await page.evaluate(() => (window as any).__popupFocusTest.release());
      expect(released).toBe(intent === 'layout' ? 1 : 0);
      if (intent === 'tab') await expect(page.locator('.leaflet-popup-close-button')).toBeFocused();
      else if (intent === 'external-search') await expect(externalSearch).toBeFocused();
      else await expect(rows.first()).toBeFocused();
      results.push({ intent, captured, released });
    } finally { await page.evaluate(() => (window as any).__popupFocusTest?.cleanup()); }
  }
  await search.fill('reset-local'); await search.fill(''); await next.click();
  await expect(rows.first()).toBeFocused();
  await testInfo.attach('popup-focus-order.json', { body: JSON.stringify({ mapFixture, results, ordinaryPagerFocus: true }, null, 2), contentType: 'application/json' });
});
