import assert from 'node:assert/strict';
import { chromium, devices, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argumentsOf, saveJson, sha256, snapshotInfo, workspace } from './common.js';
import { startBrowserFixture } from './browser-fixture.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
if (!args.out) throw new Error('--out is required');
const info = await snapshotInfo(root);
const builtIndexHash = sha256(await readFile(resolve(root, 'dist/client/index.html')));
const fixture = await startBrowserFixture(root);
const browser = await chromium.launch();
const results: any[] = [];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4e8"/></svg>';
const filters = { cities: [], from: info.snapshot.coverage.from, to: info.snapshot.coverage.to, genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30 };
const representative = info.snapshot.performances.find((item: any) => item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude) && item.latitude > 33 && item.latitude < 39 && item.longitude > 124 && item.longitude < 132);
assert.ok(representative, 'real snapshot has a located venue');

async function context() {
  const context = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.addInitScript('globalThis.__name = function(value) { return value; };');
  await page.addInitScript(value => {
    (window as any).__CULTURE_PERFORMANCE__ = true;
    (window as any).__focusEvents = [];
    for (const type of ['focusin', 'focusout']) document.addEventListener(type, event => {
      (window as any).__focusEvents.push({ type, time: performance.now(), target: (event.target as HTMLElement)?.className });
    });
    new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) if (node instanceof HTMLElement && (node.matches('.map-popup') || node.querySelector('.map-popup'))) {
        (window as any).__focusEvents.push({ type: 'popup-detached', time: performance.now() });
      }
    }).observe(document, { childList: true, subtree: true });
    if (!localStorage.getItem('culture-desk.filters.v3')) localStorage.setItem('culture-desk.filters.v3', JSON.stringify(value));
  }, filters);
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === fixture.ready.url) return route.continue();
    if (route.request().resourceType() === 'image') return route.fulfill({ contentType: 'image/svg+xml', body: svg });
    return route.abort('blockedbyclient');
  });
  return { context, page };
}

async function stable(page: Page) {
  await page.waitForFunction(() => document.querySelector('.results')?.getAttribute('aria-busy') === 'false');
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function matchingMap(page: Page, data: any) {
  const located = data.items.filter((item: any) => item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
    && item.latitude >= 33 && item.latitude <= 39 && item.longitude >= 124 && item.longitude <= 132).length;
  await page.waitForFunction(({ located, total }) => [...document.querySelectorAll<HTMLElement>('[data-performance-count]')].reduce((sum, item) => sum + Number(item.dataset.performanceCount), 0) === located
    && document.querySelector('.map-scope-note')?.textContent?.includes(`검색 결과 ${total.toLocaleString('ko-KR')}건`), { located, total: data.total });
  await stable(page);
}

async function mapState(page: Page) {
  return page.evaluate(() => ({
    visible: !!document.querySelector('.leaflet-container'),
    panePosition: document.querySelector('.leaflet-pane') ? getComputedStyle(document.querySelector('.leaflet-pane')!).position : null,
    styles: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter(link => /PerformanceMap-/.test(link.href)).map(link => ({ href: link.href, loaded: !!link.sheet })),
    alert: document.querySelector('.map-module-state [role="alert"]')?.textContent,
    filter: (document.querySelector('input[type="search"]') as HTMLInputElement | null)?.value,
    popupFactories: performance.getEntriesByName('culture:map-popup').length,
    activeElement: document.activeElement?.outerHTML.slice(0, 500),
    modalHeadings: [...document.querySelectorAll('dialog[open] h2, [role="dialog"] h2')].map(node => node.textContent),
    popupAncestors: (() => { const values = []; let node: HTMLElement | null = document.querySelector('.map-popup-show'); while (node) { const css = getComputedStyle(node); values.push({ tag: node.tagName, className: node.className, visibility: css.visibility, display: css.display, inert: node.inert, connected: node.isConnected }); node = node.parentElement; } return values; })(),
    mapButtons: [...document.querySelectorAll('.map-panel button')].map(node => ({ text: node.textContent, label: node.getAttribute('aria-label') })),
    focusTrace: performance.getEntriesByName('culture:map-keyboard').map(entry => ({ time: entry.startTime, detail: (entry as PerformanceMark).detail })),
    focusEvents: (window as any).__focusEvents,
  }));
}

try {
  for (const scenario of args.case === 'keyboard' ? [] : ['js', 'css', 'js-blocked']) {
    const extension = scenario === 'js-blocked' ? 'js' : scenario;
    const { context: c, page } = await context();
    const requests: string[] = [], errors: string[] = [];
    let abortNext = true;
    let blocked = scenario === 'js-blocked';
    page.on('pageerror', error => errors.push(error.message));
    await page.route(new RegExp(`/assets/PerformanceMap-[^/]+\\.${extension}$`), route => {
      requests.push(route.request().url());
      if (abortNext || blocked) { abortNext = false; return route.abort('failed'); }
      return route.continue();
    });
    await page.goto(fixture.ready.url, { waitUntil: 'domcontentloaded' });
    await stable(page);
    const searched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/performances' && new URL(response.url()).searchParams.get('q') === representative.title);
    await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill(representative.title);
    await searched;
    await stable(page);
    await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
    await stable(page);
    await page.waitForFunction(() => !!document.querySelector('.map-module-state [role="alert"]') || !!document.querySelector('.leaflet-container'));
    const before = await mapState(page);
    blocked = false;
    const retry = page.getByRole('button', { name: /지도 다시 시도|페이지 새로고침/ });
    const retryVisible = await retry.isVisible();
    if (retryVisible) {
      const navigation = (await retry.textContent())?.includes('새로고침') ? page.waitForNavigation({ waitUntil: 'domcontentloaded' }) : undefined;
      await retry.click();
      if (navigation) await navigation;
      await page.waitForFunction(() => !!document.querySelector('.map-module-state [role="alert"]') || !!document.querySelector('.leaflet-container'));
      await stable(page);
    }
    const after = await mapState(page);
    results.push({ case: `${scenario}-chunk-recovery`, passed: requests.length >= 2 && after.visible && after.panePosition === 'absolute' && after.styles.every(style => style.loaded) && after.filter === representative.title, requests, retryVisible, before, after, errors });
    await c.close();
  }

  const { context: c, page } = await context();
  const progress: Record<string, unknown> = {};
  try {
    await page.goto(`${fixture.ready.url}/#map`, { waitUntil: 'domcontentloaded' });
    await page.locator('.leaflet-container').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[data-performance-count]')].reduce((sum, item) => sum + Number(item.dataset.performanceCount), 0) > 5000);
    await stable(page);
    const initial = await mapState(page);
    assert.equal(initial.popupFactories, 0, 'national map constructs no popup DOM before interaction');
    // A real snapshot title isolates a venue while the nationwide bounds retain the low zoom path.
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/map' && new URL(response.url()).searchParams.get('q') === representative.title);
    await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill(representative.title);
    await matchingMap(page, await (await response).json());
    const marker = page.locator('.venue-map-marker').first();
    await marker.waitFor();
    await marker.focus();
    await page.keyboard.press('Enter');
    await page.locator('.map-popup-show').first().waitFor();
    await stable(page);
    const opened = await page.evaluate(() => ({ focused: document.activeElement?.classList.contains('map-popup-show'), connected: document.activeElement?.isConnected,
      factories: performance.getEntriesByName('culture:map-popup').length, buttons: document.querySelectorAll('.map-popup-show').length }));
    progress.opened = opened;
    if (!opened.focused) throw new Error('Final popup control did not receive keyboard focus');
    const hiddenTrace = await page.evaluate(() => performance.getEntriesByName('culture:map-keyboard-hidden').map(entry => (entry as PerformanceMark).detail));
    await page.setViewportSize({ width: 1360, height: 950 });
    await stable(page);
    const resized = await page.evaluate(() => ({ focused: document.activeElement?.classList.contains('map-popup-show'), connected: document.activeElement?.isConnected }));
    await page.locator('.map-panel').screenshot({ path: resolve(args.out, '..', 'frontend-keyboard-popup.png') });
    await page.keyboard.press('Escape');
    const escaped = await page.evaluate(() => ({ focused: document.activeElement?.classList.contains('venue-map-marker'), connected: document.activeElement?.isConnected,
      popups: document.querySelectorAll('.leaflet-popup').length }));
    progress.escaped = escaped;
    await page.keyboard.press('Enter');
    await page.locator('.map-popup-show').first().waitFor();
    await stable(page);
    const reopened = await page.evaluate(() => ({ focused: document.activeElement?.classList.contains('map-popup-show'), connected: document.activeElement?.isConnected,
      factories: performance.getEntriesByName('culture:map-popup').length, buttons: document.querySelectorAll('.map-popup-show').length }));
    progress.reopened = reopened;
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '검색 결과가 보이도록 지도 맞추기' }).click();
    await stable(page);
    await page.locator('.venue-map-marker').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('.map-popup-show').first().waitFor();
    await stable(page);
    const refitted = await page.evaluate(() => ({ focused: document.activeElement?.classList.contains('map-popup-show'), connected: document.activeElement?.isConnected }));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await page.evaluate(() => { location.hash = 'search'; });
    await page.locator('.performance-grid').waitFor();
    await stable(page);
    const navigated = await page.evaluate(() => ({ focusedMain: document.activeElement?.tagName === 'MAIN', connected: document.activeElement?.isConnected, popups: document.querySelectorAll('.leaflet-popup').length }));
    results.push({ case: 'keyboard-popup', passed: opened.focused && opened.connected && resized.focused && resized.connected && escaped.focused && escaped.connected && escaped.popups === 0 && reopened.focused && reopened.connected && reopened.factories === opened.factories && reopened.buttons === opened.buttons && refitted.focused && refitted.connected && navigated.focusedMain && navigated.connected && navigated.popups === 0, initial, representative: { id: representative.id, title: representative.title }, opened, resized, escaped, reopened, refitted, navigated, hiddenTrace });
  } catch (error) { results.push({ case: 'keyboard-popup', passed: false, ...progress, error: String(error), state: await mapState(page) }); }
  finally { await c.close(); }
} finally { await browser.close(); await fixture.stop(); }

const report = { measuredAt: new Date().toISOString(), scope: 'Functional regression checks against real snapshot with local substitutes for external images; not latency/GPU measurements.', snapshotHash: info.hash, count: info.count,
  builtIndexHash, builtIndexStable: builtIndexHash === sha256(await readFile(resolve(root, 'dist/client/index.html'))), results };
await saveJson(args.out, report);
console.log(JSON.stringify(report, null, 2));
if (!report.builtIndexStable || results.some(result => !result.passed)) process.exitCode = 1;
