import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { argumentsOf, clientFingerprint, saveJson, snapshotInfo, sourceFingerprint, workspace } from './common.js';
import { startBrowserFixture } from './browser-fixture.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
assert.ok(args.out, '--out is required');
assert.ok(args.expect === undefined || ['observe', 'pass'].includes(args.expect));
const before = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
const info = await snapshotInfo(root), dates = { from: info.snapshot.coverage.from, to: info.snapshot.coverage.to };
const sourceRows = new Map(info.snapshot.performances.map((item: any) => [item.id, item]));
const rows: any[] = [], cleanupErrors: string[] = [];
let fixture: Awaited<ReturnType<typeof startBrowserFixture>> | undefined, browser: Browser | undefined, fatalError: string | undefined;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4e8"/></svg>';
async function state(page: Page) {
  return page.evaluate(() => {
    const popup = document.querySelector('.map-popup');
    return { open: !!popup, query: popup?.querySelector<HTMLInputElement>('input')?.value, page: popup?.querySelector('.map-popup-page')?.textContent,
      ids: [...(popup?.querySelectorAll<HTMLElement>('.map-popup-show') ?? [])].map(element => Number(element.dataset.performanceId)),
      layers: performance.getEntriesByName('culture:map-layers').map(entry => ({ duration: entry.duration, detail: (entry as PerformanceMeasure).detail })) };
  });
}
try {
  fixture = await startBrowserFixture(root); const url = fixture.ready.url;
  const mapBody = await (await fetch(`${url}/api/map?${new URLSearchParams(dates)}`)).json() as any;
  const searchBody = await (await fetch(`${url}/api/performances?${new URLSearchParams(dates)}`)).json() as any;
  const groups = new Map<string, any[]>();
  for (const item of mapBody.items) if (item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)) {
    const key = `${item.latitude.toFixed(5)},${item.longitude.toFixed(5)}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const dense = [...groups.values()].sort((a, b) => b.length - a.length)[0]; assert.equal(dense.length, 210);
  const first = dense[0], ids = new Set(dense.map(item => item.id));
  const other = mapBody.items.find((item: any) => item.cityId === first.cityId && !ids.has(item.id) && item.locationPrecision === 'venue'); assert.ok(other);
  // Only the diagnostic sibling coordinate is synthetic so both actual-ID markers
  // are reachable in one viewport; no facility relation or geographic claim.
  const items = [...dense, { ...other, latitude: first.latitude + .0015, longitude: first.longitude + .0015 }];
  const common = { total: items.length, page: 1, pages: 1, pendingDetails: 0, partial: false, truncated: false };
  browser = await chromium.launch();
  for (const name of ['high-zoom', 'two-marker']) {
    const row: any = { name, errors: [], checks: [], passed: false }; rows.push(row);
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'ko-KR', serviceWorkers: 'block' });
      const page = await context.newPage(); page.setDefaultTimeout(12_000);
      page.on('pageerror', error => row.errors.push(error.message));
      await page.addInitScript('globalThis.__name = function(value) { return value; };');
      await page.addInitScript(filters => { localStorage.setItem('culture-desk.filters.v3', JSON.stringify(filters)); (window as any).__CULTURE_PERFORMANCE__ = true; },
        { cities: [first.cityId], ...dates, genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30 });
      await page.route('**/*', async route => {
        if (page.isClosed()) return;
        const request = route.request(), target = new URL(request.url());
        if (target.origin === url) {
          if (target.pathname === '/api/map') return route.fulfill({ json: { ...mapBody, ...common, items } });
          if (target.pathname === '/api/performances') return route.fulfill({ json: { ...searchBody, ...common, items: [sourceRows.get(first.id), sourceRows.get(dense.at(-1).id)] } });
          return route.continue();
        }
        if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/svg+xml', body: svg });
        return route.abort('blockedbyclient');
      });
      await page.goto(`${url}/#map`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[data-performance-count]')].reduce((sum, element) => sum + Number(element.dataset.performanceCount), 0) === 211);
      await page.locator('.map-result-list .card-locate').first().click();
      await page.waitForFunction(id => (document.activeElement as HTMLElement)?.dataset.performanceId === String(id), first.id);
      await page.waitForFunction(() => document.querySelectorAll('.venue-map-marker').length === 2);
      const marker = page.locator('.venue-map-marker[data-performance-count="210"]'), sibling = page.locator('.venue-map-marker[data-performance-count="1"]');
      const search = page.locator('.map-popup-search input');
      if (name === 'high-zoom') {
        await search.fill('예술의전당'); await page.getByRole('button', { name: '이 위치의 공연 다음 페이지', exact: true }).click();
        const inputNode = await search.elementHandle(), markerNode = await marker.elementHandle();
        row.before = await state(page);
        await page.locator('.leaflet-control-zoom-in').click(); await page.waitForTimeout(350);
        row.after = await state(page);
        row.sameInput = await inputNode!.evaluate(element => element.isConnected && element === document.querySelector('.map-popup-search input'));
        row.sameMarker = await markerNode!.evaluate(element => element.isConnected && element === document.querySelector('.venue-map-marker[data-performance-count="210"]'));
        row.passed = row.after.open && row.after.query === row.before.query && row.after.page === row.before.page && row.sameInput && row.sameMarker;
        await inputNode?.dispose(); await markerNode?.dispose();
      } else {
        for (const local of ['query', 'page2']) for (const method of ['pointer', 'keyboard']) {
          await search.fill('reset-local'); await search.fill('');
          if (local === 'query') await search.fill(dense.at(-1).title);
          else await page.getByRole('button', { name: '이 위치의 공연 다음 페이지', exact: true }).click();
          const expected = await state(page);
          await search.focus(); await page.keyboard.press('Escape'); await sibling.click();
          await page.locator('.map-popup-show').first().focus(); await page.keyboard.press('Escape');
          if (method === 'pointer') await marker.click(); else { await marker.focus(); await page.keyboard.press('Enter'); }
          await page.locator('.map-popup').waitFor(); await page.waitForTimeout(100);
          const actual = await state(page);
          row.checks.push({ local, method, expected, actual, passed: expected.query === actual.query && expected.page === actual.page && JSON.stringify(expected.ids) === JSON.stringify(actual.ids) });
        }
        row.passed = row.checks.every((check: any) => check.passed);
      }
      await page.screenshot({ path: args.out.replace(/\.json$/, `-${name}.png`) });
      assert.deepEqual(row.errors, []);
    } catch (error) { row.error = String(error); row.passed = false; }
    finally { try { await context?.close(); } catch (error) { cleanupErrors.push(String(error)); } }
    await saveJson(args.out, { status: 'partial', before, rows, cleanupErrors });
  }
} catch (error) { fatalError = String(error); }
finally { try { await browser?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  finally { try { await fixture?.stop(); } catch (error) { cleanupErrors.push(String(error)); } } }
const after = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
await saveJson(args.out, { at: new Date().toISOString(), root, scope: 'Finite functional diagnostic; original210 dense rows plus one original-ID sibling at an explicitly synthetic nearby coordinate, local image stubs. No latency acceptance.', before, after, rows, cleanupErrors, fatalError });
console.log(JSON.stringify({ out: args.out, rows: rows.map(row => ({ name: row.name, passed: row.passed, error: row.error })), cleanupErrors, fatalError }));
if (fatalError || cleanupErrors.length || rows.some(row => row.error) || (args.expect === 'pass' && rows.some(row => !row.passed)) || before.source.hash !== after.source.hash || before.client.hash !== after.client.hash) process.exitCode = 1;
