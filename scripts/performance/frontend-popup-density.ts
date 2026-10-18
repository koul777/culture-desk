import assert from 'node:assert/strict';
import { chromium, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { basename, dirname, resolve } from 'node:path';
import { argumentsOf, clientFingerprint, saveJson, snapshotInfo, sourceFingerprint, workspace } from './common.js';
import { startBrowserFixture } from './browser-fixture.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
assert.ok(args.out, '--out is required');
const widths = (args.widths ?? '1440,375,320').split(',').map(Number);
assert.ok(widths.length > 0 && widths.every(width => [1440, 375, 320].includes(width)));
const groupLimit = Number(args.groups ?? '2'); assert.ok(groupLimit === 1 || groupLimit === 2);
const info = await snapshotInfo(root);
const before = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
const rows: any[] = [], cleanupErrors: string[] = [];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4e8"/></svg>';
let fixture: Awaited<ReturnType<typeof startBrowserFixture>> | undefined, browser: Browser | undefined, fatalError: string | undefined;
const dates = { from: info.snapshot.coverage.from, to: info.snapshot.coverage.to };
const snapshotById = new Map<number, any>(info.snapshot.performances.map((item: any) => [item.id, item]));
const knownPosterHosts = new Set(info.snapshot.performances.flatMap((item: any) => { try { return item.poster ? [new URL(item.poster).hostname] : []; } catch { return []; } }));
const groups: any[] = [];
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Probe exceeded ${milliseconds}ms`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function settled(page: Page) {
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
async function popupState(page: Page) {
  return page.evaluate(() => {
    const popup = document.querySelector('.map-popup'), scroll = document.querySelector('.leaflet-popup-content');
    const box = (element: Element | null) => { if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const shows = [...document.querySelectorAll<HTMLButtonElement>('.map-popup-show')];
    const mapBox = document.querySelector('.map-panel')!.getBoundingClientRect(), scrollBox = scroll?.getBoundingClientRect();
    const visibleRatio = (element: Element | null) => {
      if (!element || !scrollBox) return 0;
      const r = element.getBoundingClientRect();
      const height = Math.max(0, Math.min(r.bottom, scrollBox.bottom, mapBox.bottom) - Math.max(r.top, scrollBox.top, mapBox.top));
      return height / r.height;
    };
    return { heading: popup?.querySelector('strong')?.textContent, dialogName: popup?.getAttribute('aria-label'), popup: box(popup), scroll: box(scroll),
      mapBox: box(document.querySelector('.map-panel')), headingBox: box(popup?.querySelector('strong') ?? null), firstShowBox: box(shows[0] ?? null),
      firstShowVisibleRatio: visibleRatio(shows[0] ?? null), activeVisibleRatio: visibleRatio(shows.includes(document.activeElement as HTMLButtonElement) ? document.activeElement : null),
      scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight, clientHeight: scroll?.clientHeight,
      descendants: popup?.querySelectorAll('*').length, showCount: shows.length, viewportWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
      activeIndex: shows.indexOf(document.activeElement as HTMLButtonElement), activeClass: document.activeElement?.className,
      visibleIndices: shows.flatMap((show, index) => { const r = show.getBoundingClientRect(), p = scroll!.getBoundingClientRect(); return r.bottom > p.top && r.top < p.bottom ? [index] : []; }),
      showLabels: shows.map(show => show.getAttribute('aria-label')), showTexts: shows.map(show => show.textContent),
      route: popup?.querySelector<HTMLAnchorElement>('.map-popup-route')?.href, threeDLabel: popup?.querySelector('.map-popup-3d')?.getAttribute('aria-label'),
      searchControls: popup?.querySelectorAll('input,select,[role="searchbox"]').length,
      factories: performance.getEntriesByName('culture:map-popup').map(entry => ({ startTime: entry.startTime, duration: entry.duration, detail: (entry as PerformanceMeasure).detail })),
      longTasks: (window as any).__densityLongTasks };
  });
}
try {
  fixture = await startBrowserFixture(root);
  const appUrl = fixture.ready.url;
  const params = new URLSearchParams(dates);
  const mapResponse = await (await fetch(`${appUrl}/api/map?${params}`)).json() as any;
  const searchResponse = await (await fetch(`${appUrl}/api/performances?${params}`)).json() as any;
  const grouped = new Map<string, any[]>();
  for (const item of mapResponse.items) {
    if (item.locationPrecision !== 'venue' || !Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) continue;
    const key = `${item.latitude.toFixed(5)},${item.longitude.toFixed(5)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  const largest = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, groupLimit);
  for (const [coordinateKey, items] of largest) groups.push({ coordinateKey, count: items.length,
    venues: [...new Set(items.map(item => item.venue))], ordered: items.map(item => ({ id: item.id, title: item.title, venue: item.venue, source: item.source })) });
  browser = await chromium.launch();
  for (let groupIndex = 0; groupIndex < largest.length; groupIndex++) for (const width of widths) {
    const [coordinateKey, items] = largest[groupIndex], first = items[0];
    const targetIndex = items.findLastIndex(item => item.venue !== first.venue), target = items[targetIndex];
    assert.ok(targetIndex > 0, 'dense group has a distinct raw venue for selection diagnosis');
    const row: any = { groupIndex, coordinateKey, width, count: items.length, first, targetIndex, target, errors: [], unexpectedExternal: [], frames: [], passed: false };
    rows.push(row);
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({ ...(width === 1440 ? devices['Desktop Chrome'] : devices['Pixel 7']), viewport: { width, height: width === 1440 ? 1000 : 812 }, reducedMotion: 'reduce', locale: 'ko-KR', serviceWorkers: 'block' });
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      page.on('pageerror', error => row.errors.push(error.message));
      await page.addInitScript('globalThis.__name = function(value) { return value; };');
      await page.addInitScript(filters => {
        localStorage.setItem('culture-desk.filters.v3', JSON.stringify(filters));
        (window as any).__CULTURE_PERFORMANCE__ = true; (window as any).__densityLongTasks = [];
        try { new PerformanceObserver(list => (window as any).__densityLongTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true }); } catch {}
      }, { cities: [first.cityId], ...dates, genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30 });
      const sourceCounts = { KOPIS: items.filter(item => item.source === 'KOPIS').length, CULTURE: items.filter(item => item.source === 'CULTURE').length };
      const common = { total: items.length, page: 1, pages: Math.ceil(items.length / 30), sourceCounts, pendingDetails: 0, partial: false };
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === appUrl) {
          if (url.pathname === '/api/map') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...mapResponse, ...common, items, truncated: false }) });
          if (url.pathname === '/api/performances') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...searchResponse, ...common, items: items.slice(0, 30).map(item => snapshotById.get(item.id)) }) });
          if (url.pathname === '/api/maps/vworld/config') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available: true }) });
          if (url.pathname === '/api/maps/vworld/frame') {
            row.frames.push(Object.fromEntries(url.searchParams));
            const channel = JSON.stringify(url.searchParams.get('channel'));
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>LOCAL PROTOCOL ONLY — NO BUILDING GEOMETRY<script>setTimeout(()=>parent.postMessage({type:'culture-vworld',channel:${channel},status:'ready'},location.origin),50)</script></body></html>` });
          }
          return route.continue();
        }
        if (url.hostname === 'tile.openstreetmap.org' || (route.request().resourceType() === 'image' && knownPosterHosts.has(url.hostname))) return route.fulfill({ contentType: 'image/svg+xml', body: svg });
        row.unexpectedExternal.push(`${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
      });
      await bounded((async () => {
        await page.goto(`${appUrl}/#map`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(count => [...document.querySelectorAll<HTMLElement>('[data-performance-count]')].reduce((sum, element) => sum + Number(element.dataset.performanceCount), 0) === count
          && document.querySelector('.map-scope-note')?.textContent?.includes(`검색 결과 ${count}건`), items.length);
        await page.locator('.map-panel').scrollIntoViewIfNeeded(); await settled(page);
        row.beforeFactories = await page.evaluate(() => performance.getEntriesByName('culture:map-popup').length);
        assert.equal(row.beforeFactories, 0);
        const marker = page.locator('.venue-map-marker'); assert.equal(await marker.count(), 1);
        row.markerLabel = await marker.getAttribute('aria-label');
        const openAt = await page.evaluate(() => performance.now());
        if (width === 1440) { await marker.focus(); await page.keyboard.press('Enter'); }
        else await marker.click();
        await page.waitForFunction(count => document.querySelectorAll('.map-popup-show').length === count, items.length);
        await settled(page); row.firstOpenDiagnosticMs = await page.evaluate(start => performance.now() - start, openAt);
        row.openImmediate = await popupState(page);
        // Leaflet autoPan has its own short animation even with reduced CSS motion.
        // Compare settled geometry, not the intermediate two-frame position.
        await page.waitForTimeout(400); row.open = await popupState(page);
        assert.equal(row.open.showCount, items.length); assert.equal(row.open.scrollWidth, width);
        const prefix = resolve(dirname(args.out), `${basename(args.out, '.json')}-group${groupIndex + 1}-${width}`);
        await page.locator('.map-panel').screenshot({ path: `${prefix}-popup-top.png` });
        const expectedLabels = items.map(item => `${item.title} 상세 보기`); assert.deepEqual(row.open.showLabels, expectedLabels, 'source member order retained');
        // Check the actual keyboard opening path after first pointer open, too.
        await page.locator('.map-popup-show').first().focus(); await page.keyboard.press('Escape');
        assert.equal(await page.locator('.leaflet-popup').count(), 0);
        assert.equal(await marker.evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.activeElement?.classList.contains('map-popup-show'));
        row.keyboardOpenImmediate = await popupState(page);
        await page.waitForTimeout(400); row.keyboardOpen = await popupState(page); assert.equal(row.keyboardOpen.activeIndex, 0);
        await page.keyboard.press('Tab'); row.afterTab = await popupState(page); assert.equal(row.afterTab.activeIndex, 1);
        await page.keyboard.press('Shift+Tab'); assert.equal((await popupState(page)).activeIndex, 0);
        if (width === 1440) {
          for (let index = 0; index < targetIndex; index++) await page.keyboard.press('Tab');
          row.tabToTarget = await popupState(page); assert.equal(row.tabToTarget.activeIndex, targetIndex);
          row.tabPressesFromFirst = targetIndex;
        } else {
          // Programmatic locator uses the known original order, not a product find-by-id control.
          await page.locator('.map-popup-show').nth(targetIndex).scrollIntoViewIfNeeded();
          await page.locator('.map-popup-show').nth(targetIndex).focus();
        }
        row.targetVisible = await popupState(page);
        await page.locator('.map-panel').screenshot({ path: `${prefix}-popup-target.png` });
        const detailResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/performances/${target.id}`);
        await page.keyboard.press('Enter'); await detailResponse;
        await page.getByRole('dialog', { name: target.title, exact: true }).waitFor();
        const detail = page.getByRole('dialog', { name: target.title, exact: true });
        row.detail = { title: await detail.locator('h2').textContent(), venue: await detail.locator('.detail-row').filter({ has: page.locator('dt', { hasText: /^공연장$/ }) }).locator('dd').textContent() };
        assert.ok(row.detail.venue.includes(target.venue));
        // Detail owns the selected performance; compare its 3D label with the group action.
        await detail.getByRole('button', { name: '공연장 3D로 보기', exact: true }).click();
        await page.locator('.vworld-viewer[data-status="ready"]').waitFor(); row.detail3D = row.frames.at(-1);
        await page.locator('dialog[open]').last().getByRole('button', { name: '닫기', exact: true }).click();
        await detail.getByRole('button', { name: '닫기', exact: true }).click();
        await page.locator('.map-popup-3d').click();
        await page.locator('.vworld-viewer[data-status="ready"]').waitFor(); row.group3DAfterTarget = row.frames.at(-1);
        assert.equal(row.detail3D.label, target.venue); assert.equal(row.group3DAfterTarget.label, first.venue);
        await page.locator('dialog[open]').last().getByRole('button', { name: '닫기', exact: true }).click();
        row.afterActions = await popupState(page);
        await page.locator('.map-popup-show').first().focus(); await page.keyboard.press('Escape');
        assert.equal(await marker.evaluate(element => element === document.activeElement), true);
        assert.deepEqual(row.errors, []); assert.deepEqual(row.unexpectedExternal, []);
        row.passed = true;
      })(), 90_000);
    } catch (error) { row.error = String(error); }
    finally { try { await context?.close(); } catch (error) { cleanupErrors.push(String(error)); } }
    await saveJson(args.out, { status: 'partial', before, groups, rows, cleanupErrors });
  }
} catch (error) { fatalError = String(error); }
finally { try { await browser?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  finally { try { await fixture?.stop(); } catch (error) { cleanupErrors.push(String(error)); } } }
const after = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
const report = { version: 1, measuredAt: new Date().toISOString(), root,
  scope: 'Diagnostic UX only, not performance acceptance. Real snapshot top2 coordinate groups in original API order, mocked search/map responses contain only that group. Original venue strings retained without facility-equivalence assumptions. External tiles/posters replaced locally. 3D is only a local VWorld message-protocol fixture, with no geometry/GPU/live provider claim. Desktop target reached by sequential Tab; mobile target located by harness-known index, not an app search control.',
  snapshot: { hash: info.hash, count: info.count }, before, after, sourceStable: before.source.hash === after.source.hash, clientStable: before.client.hash === after.client.hash, groups, rows, cleanupErrors, fatalError };
await saveJson(args.out, report);
console.log(JSON.stringify({ out: args.out, fatalError, sourceStable: report.sourceStable, clientStable: report.clientStable, rows: rows.map(row => ({ groupIndex: row.groupIndex, width: row.width, count: row.count, passed: row.passed, error: row.error, factoryCount: row.open?.factories.length })) }, null, 2));
if (fatalError || cleanupErrors.length || !report.sourceStable || !report.clientStable || rows.some(row => !row.passed)) process.exitCode = 1;
