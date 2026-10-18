import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { argumentsOf, clientFingerprint, saveJson, snapshotInfo, sourceFingerprint, workspace } from './common.js';
import { startBrowserFixture } from './browser-fixture.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
assert.ok(args.out?.endsWith('.json'), '--out must name a JSON evidence file');
const intent = args.intent ?? 'tab';
assert.ok(['tab', 'external-search', 'layout'].includes(intent));
assert.ok(args.expect === undefined || ['observe', 'retained'].includes(args.expect));
const before = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
const info = await snapshotInfo(root), dates = { from: info.snapshot.coverage.from, to: info.snapshot.coverage.to };
const row: any = { intent, errors: [], cleanupErrors: [], stage: 'setup' };
let fixture: Awaited<ReturnType<typeof startBrowserFixture>> | undefined, browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined;
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Focus probe exceeded ${milliseconds}ms`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
try {
  await bounded((async () => {
    fixture = await startBrowserFixture(root); const url = fixture.ready.url;
    const body = await (await fetch(`${url}/api/map?${new URLSearchParams(dates)}`)).json() as any;
    const groups = new Map<string, any[]>();
    for (const item of body.items) if (item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)) {
      const key = `${item.latitude.toFixed(5)},${item.longitude.toFixed(5)}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const items = [...groups.values()].sort((a, b) => b.length - a.length)[0]; assert.equal(items.length, 210);
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'ko-KR', serviceWorkers: 'block' });
    page = await context.newPage(); const current = page; current.setDefaultTimeout(12_000);
    current.on('pageerror', error => row.errors.push(error.message));
    await current.addInitScript('globalThis.__name = function(value) { return value; };');
    await current.addInitScript(filters => localStorage.setItem('culture-desk.filters.v3', JSON.stringify(filters)),
      { cities: [items[0].cityId], ...dates, genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30 });
    await current.route('**/*', async route => {
      if (current.isClosed()) return;
      const request = route.request(), target = new URL(request.url());
      if (target.origin === url) {
        if (target.pathname === '/api/map') return route.fulfill({ json: { ...body, items, total: items.length, truncated: false, pendingDetails: 0, partial: false } });
        return route.continue();
      }
      if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4e8"/></svg>' });
      return route.abort('blockedbyclient');
    });
    await current.goto(`${url}/#map`, { waitUntil: 'domcontentloaded' });
    const marker = current.locator('.venue-map-marker[data-performance-count="210"]');
    await marker.waitFor(); await marker.focus(); await current.keyboard.press('Enter');
    await current.waitForFunction(() => document.activeElement?.classList.contains('map-popup-show'));
    await current.waitForTimeout(350);
    const next = current.getByRole('button', { name: '이 위치의 공연 다음 페이지', exact: true });
    await next.focus();
    row.stage = 'hold-one-controller-frame';
    row.capture = await current.evaluate(() => {
      const nativeFrame = window.requestAnimationFrame, nativeCancel = window.cancelAnimationFrame;
      const frames = new Map<number, FrameRequestCallback>(), heldIds = new Set<number>(), origins: string[] = []; let sequence = 1_000_000_000;
      const focus = () => { const active = document.activeElement as HTMLElement | null; return { tag: active?.tagName, class: active?.className, label: active?.getAttribute('aria-label'), text: active?.textContent, performanceId: active?.dataset.performanceId, inPopup: !!active?.closest('.map-popup'), externalSearch: active?.matches('.quick-search input') }; };
      const cleanup = () => { frames.clear(); window.requestAnimationFrame = nativeFrame; window.cancelAnimationFrame = nativeCancel; delete (window as any).__popupFocusRace; };
      window.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); heldIds.add(id); origins.push(new Error().stack ?? ''); return id; };
      window.cancelAnimationFrame = id => { if (heldIds.has(id)) frames.delete(id); else nativeCancel.call(window, id); };
      (window as any).__popupFocusRace = { cleanup, focus,
        release: () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(performance.now())); return { callbacks: batch.length, focus: focus() }; } };
      try {
        const button = document.querySelector<HTMLButtonElement>('.map-popup-pagination button:last-child')!;
        button.click();
      } finally { window.requestAnimationFrame = nativeFrame; }
      const captured = { count: frames.size, origins, focus: focus(), page: document.querySelector('.map-popup-page')?.textContent };
      return captured;
    });
    assert.equal(row.capture.count, 1, 'Only one controller frame may be delayed; unrelated frame work aborts this probe');
    assert.equal(row.capture.page, '2 / 11');
    row.stage = intent;
    if (intent === 'tab') await current.keyboard.press('Tab');
    else if (intent === 'external-search') await current.getByRole('searchbox', { name: '공연명·공연장 검색', exact: true }).click();
    else {
      await current.setViewportSize({ width: 1441, height: 1000 }); await current.setViewportSize({ width: 1440, height: 1000 });
      await current.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
    row.afterIntent = await current.evaluate(() => (window as any).__popupFocusRace.focus());
    if (intent !== 'layout') assert.notDeepEqual(row.afterIntent, row.capture.focus, 'User input must move to another actual control');
    assert.equal(row.afterIntent.performanceId, undefined, 'The intended control must not already be a show row');
    await current.screenshot({ path: args.out.replace(/\.json$/, '-after-intent.png') });
    row.stage = 'release-controller-frame';
    row.released = await current.evaluate(() => (window as any).__popupFocusRace.release());
    row.focusStolen = intent !== 'layout' && !!row.released.focus.performanceId && JSON.stringify(row.released.focus) !== JSON.stringify(row.afterIntent);
    if (args.expect === 'retained') {
      assert.equal(row.released.callbacks, intent === 'layout' ? 1 : 0);
      if (intent === 'layout') assert.ok(row.released.focus.performanceId, 'Layout-only update retains the intended automatic row focus');
      else assert.deepEqual(row.released.focus, row.afterIntent, 'New explicit user focus remains after pending frame release');
    }
    await current.screenshot({ path: args.out.replace(/\.json$/, '-after-frame.png') });
    assert.deepEqual(row.errors, []);
    row.stage = 'complete';
  })(), 90_000);
} catch (error) { row.error = String(error); }
finally {
  try { if (page && !page.isClosed()) await page.evaluate(() => (window as any).__popupFocusRace?.cleanup()); } catch (error) { row.cleanupErrors.push(String(error)); }
  try { await context?.close(); } catch (error) { row.cleanupErrors.push(String(error)); }
  try { await browser?.close(); } catch (error) { row.cleanupErrors.push(String(error)); }
  finally { try { await fixture?.stop(); } catch (error) { row.cleanupErrors.push(String(error)); } }
}
const after = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
await saveJson(args.out, { at: new Date().toISOString(), root, scope: 'One finite production-controller focus-order diagnostic. Original210 map rows and local image stubs. Only the synchronous page-button activation frame is delayed; genuine browser Tab/click or a viewport resize follows, then the one captured frame is released. No latency claim.', before, after, row });
console.log(JSON.stringify({ out: args.out, row, sourceStable: before.source.hash === after.source.hash, clientStable: before.client.hash === after.client.hash }, null, 2));
if (row.error || row.cleanupErrors.length || before.source.hash !== after.source.hash || before.client.hash !== after.client.hash) process.exitCode = 1;
