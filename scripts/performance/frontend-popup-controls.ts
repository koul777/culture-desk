import assert from 'node:assert/strict';
import { chromium, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { basename, dirname, resolve } from 'node:path';
import { argumentsOf, clientFingerprint, saveJson, snapshotInfo, sourceFingerprint, workspace } from './common.js';
import { startBrowserFixture } from './browser-fixture.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
assert.ok(args.out, '--out is required');
const widths = (args.widths ?? '1440,375,320').split(',').map(Number);
assert.ok(widths.length && widths.every(width => [1440, 375, 320].includes(width)));
const cases = (args.cases ?? 'dense210,dense112,single,mixed').split(',');
assert.ok(cases.length && cases.every(name => ['dense210', 'dense112', 'single', 'mixed'].includes(name)));
assert.ok(args['verify-viewport'] === undefined || ['true', 'false'].includes(args['verify-viewport']));
const verifyViewport = args['verify-viewport'] === 'true';
assert.ok(args.gesture === undefined || ['observe', 'cancel'].includes(args.gesture));
const info = await snapshotInfo(root), dates = { from: info.snapshot.coverage.from, to: info.snapshot.coverage.to };
const before = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
const rows: any[] = [], cleanupErrors: string[] = [];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4e8"/></svg>';
const snapshotById = new Map<number, any>(info.snapshot.performances.map((item: any) => [item.id, item]));
const posterHosts = new Set(info.snapshot.performances.flatMap((item: any) => { try { return item.poster ? [new URL(item.poster).hostname] : []; } catch { return []; } }));
let fixture: Awaited<ReturnType<typeof startBrowserFixture>> | undefined, browser: Browser | undefined, fatalError: string | undefined;
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Probe exceeded ${milliseconds}ms`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function state(page: Page) {
  return page.evaluate(() => {
    const popup = document.querySelector('.map-popup')!, scroll = popup.closest('.leaflet-popup-content')!, map = document.querySelector('.map-panel')!;
    const shows = [...popup.querySelectorAll<HTMLButtonElement>('.map-popup-show')];
    const box = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const visibleRatio = (element: Element | null, includeViewport = false) => {
      if (!element) return 0;
      const r = element.getBoundingClientRect(), s = scroll.getBoundingClientRect(), m = map.getBoundingClientRect();
      let viewportTop = window.visualViewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (window.visualViewport?.height ?? window.innerHeight);
      const sidebar = document.querySelector<HTMLElement>('.sidebar');
      if (includeViewport && sidebar) {
        const bounds = sidebar.getBoundingClientRect(), position = getComputedStyle(sidebar).position;
        if (['sticky', 'fixed'].includes(position) && bounds.top <= viewportTop + 1 && bounds.left < r.right && bounds.right > r.left) viewportTop = Math.max(viewportTop, bounds.bottom);
      }
      return Math.max(0, Math.min(r.bottom, s.bottom, m.bottom, includeViewport ? viewportBottom : Infinity) - Math.max(r.top, s.top, m.top, includeViewport ? viewportTop : -Infinity)) / r.height;
    };
    const input = popup.querySelector<HTMLInputElement>('input');
    const header = document.querySelector<HTMLElement>('.sidebar');
    return { ids: shows.map(show => Number(show.dataset.performanceId)), venues: shows.map(show => show.querySelector('.map-popup-venue')?.textContent), labels: shows.map(show => show.getAttribute('aria-label')),
      heading: popup.querySelector('strong')?.textContent, headingVisibleRatio: visibleRatio(popup.querySelector('strong')), activeId: (document.activeElement as HTMLElement)?.dataset.performanceId,
      activeVisibleRatio: visibleRatio(document.activeElement?.classList.contains('map-popup-show') ? document.activeElement : null), scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight,
      activeViewportVisibleRatio: visibleRatio(document.activeElement?.classList.contains('map-popup-show') ? document.activeElement : null, true),
      activeBox: document.activeElement?.classList.contains('map-popup-show') ? box(document.activeElement) : null,
      viewport: { offsetTop: window.visualViewport?.offsetTop ?? 0, height: window.visualViewport?.height ?? window.innerHeight,
        header: header ? { ...box(header), position: getComputedStyle(header).position } : null },
      documentScrollY: window.scrollY,
      count: popup.querySelector('.map-popup-count')?.textContent, page: popup.querySelector('.map-popup-page')?.textContent, pagerHidden: (popup.querySelector('.map-popup-pagination') as HTMLElement)?.hidden,
      search: input?.value, selection: input ? [input.selectionStart, input.selectionEnd] : null, searchActive: input === document.activeElement,
      map: box(map), popup: box(popup), scroll: box(scroll), descendants: popup.querySelectorAll('*').length,
      width: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth,
      targets: [...popup.querySelectorAll('input,.map-popup-pagination button')].filter(element => (element as HTMLElement).offsetParent !== null).map(element => ({ label: element.getAttribute('aria-label') ?? element.tagName, ...box(element) })),
      factories: performance.getEntriesByName('culture:map-popup').map(entry => ({ duration: entry.duration, detail: (entry as PerformanceMeasure).detail })),
    };
  });
}
async function focusId(page: Page, id: number) {
  await page.waitForFunction(value => (document.activeElement as HTMLElement)?.dataset.performanceId === String(value), id);
}
try {
  fixture = await startBrowserFixture(root);
  const appUrl = fixture.ready.url, params = new URLSearchParams(dates);
  const mapResponse = await (await fetch(`${appUrl}/api/map?${params}`)).json() as any;
  const searchResponse = await (await fetch(`${appUrl}/api/performances?${params}`)).json() as any;
  const grouped = new Map<string, any[]>();
  for (const item of mapResponse.items) {
    if (item.locationPrecision !== 'venue' || !Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) continue;
    const key = `${item.latitude.toFixed(5)},${item.longitude.toFixed(5)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  const largest = [...grouped.values()].sort((a, b) => b.length - a.length);
  assert.equal(largest[0].length, 210); assert.equal(largest[1].length, 112);
  const single = largest[0].filter(item => item.venue === largest[0][0].venue).slice(0, 3);
  const mixed = [largest[0][0], largest[0].find(item => item.venue !== largest[0][0].venue), largest[0].at(-1)];
  const scenarios: Record<string, any[]> = { dense210: largest[0], dense112: largest[1], single, mixed };
  browser = await chromium.launch();
  for (const name of cases) for (const width of widths) {
    const items = scenarios[name], first = items[0], target = items.at(-1), mixedVenues = new Set(items.map(item => item.venue)).size > 1;
    const row: any = { name, width, count: items.length, ordered: items.map(item => ({ id: item.id, venue: item.venue })), errors: [], unexpectedExternal: [], frames: [], requests: { search: 0, map: 0 }, passed: false };
    rows.push(row);
    const prefix = resolve(dirname(args.out), `${basename(args.out, '.json')}-${name}-${width}`);
    let context: BrowserContext | undefined, page: Page | undefined;
    try {
      context = await browser.newContext({ ...(width === 1440 ? devices['Desktop Chrome'] : devices['Pixel 7']), viewport: { width, height: width === 1440 ? 1000 : 812 }, reducedMotion: 'reduce', locale: 'ko-KR', serviceWorkers: 'block' });
      page = await context.newPage(); page.setDefaultTimeout(12_000);
      const current = page;
      page.on('pageerror', error => row.errors.push(error.message));
      await page.addInitScript('globalThis.__name = function(value) { return value; };');
      await page.addInitScript(filters => { localStorage.setItem('culture-desk.filters.v3', JSON.stringify(filters)); (window as any).__CULTURE_PERFORMANCE__ = true; },
        { cities: [first.cityId], ...dates, genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30 });
      const common = { total: items.length, page: 1, pages: 1, sourceCounts: { KOPIS: items.filter(item => item.source === 'KOPIS').length, CULTURE: items.filter(item => item.source === 'CULTURE').length }, pendingDetails: 0, partial: false };
      await page.route('**/*', async route => {
        if (current.isClosed()) return;
        const url = new URL(route.request().url());
        if (url.origin === appUrl) {
          if (url.pathname === '/api/map') { row.requests.map++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...mapResponse, ...common, items, truncated: false }) }); }
          // A two-card local fixture exposes first/last IDs via real onLocate controls;
          // popup order and membership still use the complete original map group.
          if (url.pathname === '/api/performances') { row.requests.search++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...searchResponse, ...common, items: [first, target].map(item => snapshotById.get(item.id)) }) }); }
          if (url.pathname === '/api/maps/vworld/config') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available: true }) });
          if (url.pathname === '/api/maps/vworld/frame') {
            row.frames.push(Object.fromEntries(url.searchParams)); const channel = JSON.stringify(url.searchParams.get('channel'));
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>LOCAL PROTOCOL ONLY — NO BUILDING GEOMETRY<script>setTimeout(()=>parent.postMessage({type:'culture-vworld',channel:${channel},status:'ready'},location.origin),50)</script></body></html>` });
          }
          return route.continue();
        }
        if (url.hostname === 'tile.openstreetmap.org' || (route.request().resourceType() === 'image' && posterHosts.has(url.hostname))) return route.fulfill({ contentType: 'image/svg+xml', body: svg });
        row.unexpectedExternal.push(`${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
      });
      await bounded((async () => {
        await current.goto(`${appUrl}/#map`, { waitUntil: 'domcontentloaded' });
        await current.waitForFunction(count => [...document.querySelectorAll<HTMLElement>('[data-performance-count]')].reduce((sum, element) => sum + Number(element.dataset.performanceCount), 0) === count, items.length);
        await current.locator('.map-result-list .card-locate').last().waitFor();
        // Start from a closed, low-zoom popup with a real external locate action.
        // Reload afterward so the established pointer/keyboard flow still starts fresh.
        await current.locator('.map-result-list .card-locate').last().click();
        await focusId(current, target.id); await current.waitForTimeout(400);
        row.firstLocate = await state(current);
        await current.screenshot({ path: `${prefix}-first-locate-viewport.png` });
        if (verifyViewport) assert.ok(row.firstLocate.activeViewportVisibleRatio > .99, `first low-zoom locate visible below fixed header: ${row.firstLocate.activeViewportVisibleRatio}`);
        if (args.gesture) {
          // Keep layout moving while a genuine wheel input arrives. This bounded,
          // synthetic animation exposes the pending-scroll race deterministically;
          // it is not a claim about the application's normal animation or latency.
          await current.addStyleTag({ content: '@keyframes locate-race-motion { from { transform:translateY(0) } to { transform:translateY(2000px) } } .map-popup-show:focus { animation:locate-race-motion 10s linear infinite !important }' });
          await current.evaluate(() => {
            const calls: unknown[] = [], wheels: unknown[] = [], original = window.scrollBy.bind(window);
            (window as any).__locateGestureProbe = { calls, wheels };
            window.scrollBy = ((...values: unknown[]) => { calls.push({ at: performance.now(), values, beforeY: window.scrollY }); return (original as any)(...values); }) as typeof window.scrollBy;
            window.addEventListener('wheel', event => wheels.push({ at: performance.now(), deltaY: event.deltaY, beforeY: window.scrollY }), { capture: true, passive: true });
          });
          await current.locator('.map-result-list .card-locate').last().click(); await focusId(current, target.id);
          await current.mouse.move(width - 24, 760); await current.mouse.wheel(0, -160);
          await current.waitForTimeout(800);
          row.gesture = await current.evaluate(() => ({ ...(window as any).__locateGestureProbe, afterY: window.scrollY }));
          assert.ok(row.gesture.wheels.length > 0, 'a real browser wheel input reached the page');
          row.gesture.correctionsAfterInput = row.gesture.calls.filter((call: any) => call.at >= row.gesture.wheels[0].at);
          if (args.gesture === 'cancel') assert.deepEqual(row.gesture.correctionsAfterInput, [], 'user wheel cancels pending locate correction');
        }
        await current.reload({ waitUntil: 'domcontentloaded' });
        await current.waitForFunction(count => [...document.querySelectorAll<HTMLElement>('[data-performance-count]')].reduce((sum, element) => sum + Number(element.dataset.performanceCount), 0) === count, items.length);
        await current.locator('.map-result-list .card-locate').last().waitFor();
        await current.locator('.map-panel').scrollIntoViewIfNeeded();
        row.beforeFactories = await current.evaluate(() => performance.getEntriesByName('culture:map-popup').length); assert.equal(row.beforeFactories, 0);
        const marker = current.locator('.venue-map-marker'); assert.equal(await marker.count(), 1);
        row.markerLabel = await marker.getAttribute('aria-label');
        if (mixedVenues) { assert.ok(row.markerLabel.startsWith('이 위치의 공연')); assert.ok(!row.markerLabel.includes(first.venue)); }
        await marker.click(); await current.locator('.map-popup-show').first().waitFor(); await current.waitForTimeout(400);
        row.open = await state(current); assert.deepEqual(row.open.ids, items.slice(0, 20).map(item => item.id));
        assert.equal(row.open.documentWidth, width); assert.ok(row.open.headingVisibleRatio > .99, `heading fully visible: ${row.open.headingVisibleRatio}`);
        assert.deepEqual(row.open.venues, items.slice(0, 20).map(item => item.venue));
        assert.equal(await current.locator('.map-popup-3d').count(), mixedVenues ? 0 : 1);
        assert.equal(await current.locator('.map-popup-route').count(), mixedVenues ? 0 : 1);
        for (const targetBox of row.open.targets) assert.ok(targetBox.width >= 44 && targetBox.height >= 44, '44px target');
        await current.locator('.map-panel').screenshot({ path: `${prefix}-top.png` });
        await current.locator('.map-popup-show').first().focus(); await current.keyboard.press('Escape');
        assert.equal(await marker.evaluate(element => element === document.activeElement), true);
        await current.keyboard.press('Enter'); await focusId(current, first.id); await current.waitForTimeout(400);
        row.keyboard = await state(current); assert.ok(row.keyboard.activeVisibleRatio > .99, `keyboard row fully visible: ${row.keyboard.activeVisibleRatio}`);
        await current.keyboard.press('Tab'); await focusId(current, items[1].id);
        const requestsBefore = { ...row.requests };
        row.internalScroll = [];
        const collected: number[] = [];
        for (let index = 0; index < Math.ceil(items.length / 20); index++) {
          const view = await state(current); collected.push(...view.ids);
          assert.equal(view.page, `${index + 1} / ${Math.ceil(items.length / 20)}`);
          if (index < Math.ceil(items.length / 20) - 1) {
            const scrollBefore = await current.evaluate(() => window.scrollY);
            await current.getByRole('button', { name: '이 위치의 공연 다음 페이지', exact: true }).click(); await focusId(current, items[(index + 1) * 20].id);
            const scrollAfter = await current.evaluate(() => window.scrollY);
            row.internalScroll.push({ action: 'page', scrollBefore, scrollAfter });
            assert.ok(Math.abs(scrollAfter - scrollBefore) <= 1, 'local page change does not move document');
          }
        }
        assert.deepEqual(collected, items.map(item => item.id), 'every original id and its order survives all pages'); row.collectedIds = collected;
        if (items.length > 20) assert.equal(await current.getByRole('button', { name: '이 위치의 공연 다음 페이지', exact: true }).isDisabled(), true);
        const search = current.getByRole('searchbox', { name: '이 위치의 공연명·공연장 검색', exact: true });
        if (mixedVenues || items.length > 20) {
          const searchNode = await search.elementHandle(), previousNode = await current.locator('.map-popup-pagination button').first().elementHandle();
          const scrollBefore = await current.evaluate(() => window.scrollY);
          await search.fill('없는공연장-XYZ-987'); row.empty = await state(current); assert.deepEqual(row.empty.ids, []); assert.ok(row.empty.count.includes('0건')); assert.equal(row.empty.searchActive, true);
          row.internalScroll.push({ action: 'search', scrollBefore, scrollAfter: row.empty.documentScrollY });
          assert.ok(Math.abs(row.empty.documentScrollY - scrollBefore) <= 1, 'local search does not move document');
          await search.fill('');
          const preComposition = (await state(current)).ids;
          await search.dispatchEvent('compositionstart');
          await search.evaluate(element => { const input = element as HTMLInputElement; input.value = '자유'; input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '자유', isComposing: true })); });
          assert.deepEqual((await state(current)).ids, preComposition, 'in-progress IME must not filter');
          await search.press('Escape'); assert.equal(await current.locator('.leaflet-popup').count(), 1, 'IME Escape does not close popup');
          // Native search fields may clear on Escape. Explicitly commit the next
          // composition value; this is a contract probe, not an OS IME replay.
          await search.evaluate(element => { (element as HTMLInputElement).value = '자유'; });
          await search.dispatchEvent('compositionend', { data: '자유' });
          assert.deepEqual((await state(current)).ids, items.filter(item => item.title.includes('자유') || item.venue.includes('자유')).slice(0, 20).map(item => item.id));
          row.composition = await state(current);
          await search.fill('예술전당'); await search.evaluate(element => (element as HTMLInputElement).setSelectionRange(2, 2)); await current.keyboard.insertText('의');
          const caret = await state(current); assert.equal(caret.search, '예술의전당'); assert.deepEqual(caret.selection, [3, 3]); assert.equal(caret.searchActive, true);
          await current.setViewportSize({ width: width + 1, height: width === 1440 ? 1000 : 812 });
          await current.setViewportSize({ width, height: width === 1440 ? 1000 : 812 }); await current.waitForTimeout(100);
          row.caret = await state(current); assert.deepEqual(row.caret.selection, [3, 3]); assert.equal(row.caret.searchActive, true);
          assert.equal(await searchNode!.evaluate(element => element === document.querySelector('.map-popup-search input')), true);
          assert.equal(await previousNode!.evaluate(element => element === document.querySelector('.map-popup-pagination button')), true);
          await search.fill(target.title); row.titleSearch = await state(current);
          assert.deepEqual(row.titleSearch.ids, items.filter(item => item.title.toLocaleLowerCase('ko-KR').includes(target.title.toLocaleLowerCase('ko-KR')) || item.venue.toLocaleLowerCase('ko-KR').includes(target.title.toLocaleLowerCase('ko-KR'))).slice(0, 20).map(item => item.id));
          await searchNode?.dispose(); await previousNode?.dispose();
        } else {
          assert.equal(await search.count(), 0); assert.equal(row.open.pagerHidden, true);
          assert.deepEqual(row.open.labels, items.map(item => `${item.title} 상세 보기`));
        }
        assert.deepEqual(row.requests, requestsBefore, 'all popup searching/paging is local');
        const targetRow = current.locator(`.map-popup-show[data-performance-id="${target.id}"]`);
        await targetRow.focus(); const returnTarget = await targetRow.elementHandle(); await current.keyboard.press('Enter');
        const detail = current.getByRole('dialog', { name: target.title, exact: true }); await detail.waitFor();
        row.detailVenue = await detail.locator('.detail-row').filter({ has: current.locator('dt', { hasText: /^공연장$/ }) }).locator('dd').textContent(); assert.ok(row.detailVenue.includes(target.venue));
        await detail.getByRole('button', { name: '공연장 3D로 보기', exact: true }).click(); await current.locator('.vworld-viewer[data-status="ready"]').waitFor();
        row.detail3D = row.frames.at(-1); assert.equal(row.detail3D.label, target.venue);
        await current.locator('dialog[open]').last().getByRole('button', { name: '닫기', exact: true }).click();
        await detail.getByRole('button', { name: '닫기', exact: true }).click(); await focusId(current, target.id);
        assert.equal(await returnTarget!.evaluate(element => element.isConnected && element === document.activeElement), true, 'same row survives detail/3D return'); await returnTarget?.dispose();
        row.returned = await state(current);
        if (!mixedVenues) {
          await current.locator('.map-popup-3d').click(); await current.locator('.vworld-viewer[data-status="ready"]').waitFor(); assert.equal(row.frames.at(-1).label, first.venue);
          await current.locator('dialog[open]').last().getByRole('button', { name: '닫기', exact: true }).click();
        }
        if (mixedVenues || items.length > 20) await search.fill('없는공연장-XYZ-987');
        await current.locator('.map-result-list .card-locate').first().click(); await focusId(current, first.id); await current.waitForTimeout(400);
        row.externalFirst = await state(current); assert.equal(row.externalFirst.search ?? '', ''); assert.equal(row.externalFirst.page, `1 / ${Math.ceil(items.length / 20)}`);
        await current.locator('.map-result-list .card-locate').last().click(); await focusId(current, target.id); await current.waitForTimeout(400);
        row.externalLast = await state(current); assert.equal(row.externalLast.page, `${Math.ceil(items.length / 20)} / ${Math.ceil(items.length / 20)}`);
        await current.screenshot({ path: `${prefix}-external-viewport.png` });
        if (verifyViewport) assert.ok(row.externalLast.activeViewportVisibleRatio > .99, `external locate visible below fixed header: ${row.externalLast.activeViewportVisibleRatio}`);
        if (mixedVenues || items.length > 20) {
          row.stage = 'same-id-locate';
          await search.fill('없는공연장-XYZ-987');
          await current.locator('.map-result-list .card-locate').last().click();
          await focusId(current, target.id); await current.waitForTimeout(400); row.sameIdLocate = await state(current);
          assert.equal(row.sameIdLocate.search, ''); assert.equal(row.sameIdLocate.page, row.externalLast.page);
          if (verifyViewport) assert.ok(row.sameIdLocate.activeViewportVisibleRatio > .99, `same-ID locate visible below fixed header: ${row.sameIdLocate.activeViewportVisibleRatio}`);
        }
        await current.locator('.map-panel').scrollIntoViewIfNeeded(); await current.waitForTimeout(400);
        row.stage = 'selected-row-reopen';
        await current.locator('.map-panel').screenshot({ path: `${prefix}-selected.png` });
        await current.keyboard.press('Escape'); assert.equal(await marker.evaluate(element => element === document.activeElement), true);
        await current.keyboard.press('Enter'); await focusId(current, target.id); row.reopened = await state(current);
        assert.equal(row.reopened.page, row.externalLast.page); assert.ok(row.reopened.activeVisibleRatio > .99);
        if (mixedVenues || items.length > 20) {
          row.stage = 'local-state-reopen'; row.localReopens = [];
          const states = [...(items.length > 20 ? ['page2'] : []), 'title', 'empty'];
          for (const localState of states) for (const method of ['keyboard', 'pointer']) {
            // Force the search transition so this setup starts at page1 even if
            // the prior query was already blank on a later page.
            await search.fill('reset-local-probe'); await search.fill('');
            if (localState === 'page2') await current.getByRole('button', { name: '이 위치의 공연 다음 페이지', exact: true }).click();
            else await search.fill(localState === 'title' ? first.title : '없는공연장-XYZ-987');
            await search.focus(); const expected = await state(current); await current.keyboard.press('Escape');
            assert.equal(await marker.evaluate(element => element === document.activeElement), true);
            if (method === 'keyboard') await current.keyboard.press('Enter'); else await marker.click();
            await current.locator('.map-popup').waitFor(); await current.waitForTimeout(100);
            const actual = await state(current); row.localReopens.push({ localState, method, expected, actual });
          }
          for (const reopen of row.localReopens) {
            assert.equal(reopen.actual.search, reopen.expected.search, `${reopen.localState}/${reopen.method} retains local query`);
            assert.equal(reopen.actual.page, reopen.expected.page, `${reopen.localState}/${reopen.method} retains local page`);
            assert.deepEqual(reopen.actual.ids, reopen.expected.ids, `${reopen.localState}/${reopen.method} retains local rows`);
            assert.ok(Math.abs(reopen.actual.documentScrollY - reopen.expected.documentScrollY) <= 1, `${reopen.localState}/${reopen.method} does not scroll the document`);
            if (reopen.method === 'keyboard') {
              if (reopen.actual.ids.length) assert.ok(reopen.actual.ids.includes(Number(reopen.actual.activeId)), 'keyboard reopens onto a current-page row');
              else assert.equal(reopen.actual.searchActive, true, 'empty search reopens onto search field');
            }
          }
        }
        assert.equal(row.reopened.documentWidth, width); assert.deepEqual(row.requests, requestsBefore); assert.deepEqual(row.errors, []); assert.deepEqual(row.unexpectedExternal, []);
        row.passed = true;
        row.stage = 'complete';
      })(), 120_000);
    } catch (error) {
      row.error = String(error);
      if (page && !page.isClosed()) {
        try { row.failureState = await state(page); } catch {}
        try { await page.screenshot({ path: `${prefix}-failure.png` }); } catch {}
      }
    } finally { try { await context?.close(); } catch (error) { cleanupErrors.push(String(error)); } }
    await saveJson(args.out, { status: 'partial', before, rows, cleanupErrors });
  }
} catch (error) { fatalError = String(error); }
finally { try { await browser?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  finally { try { await fixture?.stop(); } catch (error) { cleanupErrors.push(String(error)); } } }
const after = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
const report = { version: 1, measuredAt: new Date().toISOString(), root,
  verifyViewport, gestureMode: args.gesture ?? null,
  scope: 'Functional UX diagnostic only; no latency acceptance. Original current-snapshot map groups and raw venue strings, mocked map group plus two actual search cards for external first/last selection. Synthetic local tiles/posters and VWorld message-protocol frame only, with no building geometry, GPU, or live provider claim. Actual DOM input/keyboard/detail flows; IME events are synthetic composition-contract checks, not an OS IME certification.',
  snapshot: { hash: info.hash, count: info.count }, before, after, sourceStable: before.source.hash === after.source.hash, clientStable: before.client.hash === after.client.hash, rows, cleanupErrors, fatalError };
await saveJson(args.out, report);
console.log(JSON.stringify({ out: args.out, fatalError, sourceStable: report.sourceStable, clientStable: report.clientStable, rows: rows.map(row => ({ name: row.name, width: row.width, passed: row.passed, error: row.error })) }, null, 2));
if (fatalError || cleanupErrors.length || !report.sourceStable || !report.clientStable || rows.some(row => !row.passed)) process.exitCode = 1;
