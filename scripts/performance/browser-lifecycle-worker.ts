import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type BrowserContext, type CDPSession, type ElementHandle, type Locator, type Page, type Request, type Response } from '@playwright/test';
import { argumentsOf, sha256, snapshotInfo } from './common.js';
import { deadline, rasterMetadata } from './poster-runtime.js';

// The external supervisor owns Chromium and the fixture. This worker owns only
// one context/page and a bounded diagnostic ledger; it never launches a process.
const args = argumentsOf();
assert.ok(args.root && args.manifest && args.out && args.samples && args.url);
assert.ok(process.env.CULTURE_LIFECYCLE_BROWSER_WS, 'Only the lifecycle supervisor starts this worker');
const root = resolve(args.root), output = resolve(args.out), samples = resolve(args.samples), url = args.url;
assert.equal(new URL(url).hostname, '127.0.0.1');
const mode = args.mode; assert.ok(mode === 'smoke' || mode === 'soak');
const maxWallMs = Number(args['max-wall-minutes']) * 60000;
assert.equal(maxWallMs, (mode === 'smoke' ? 5 : 90) * 60000);
const control = args.control ? resolve(args.control) : undefined;
const LIMITS = { requests: 256, routes: 256, responseTasks: 8, oracleKeys: 128, recent: 100, weakRefs: 256, cycles: 1200 };
const info = await snapshotInfo(root); assert.equal(info.count, 5649);
const manifestPath = resolve(args.manifest), manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assert.equal(manifest.version, 2); assert.equal(manifest.complete, true); assert.equal(manifest.snapshot.hash, info.hash);
const images = new Map<string, { body: Buffer; mime: string; hash: string; width: number; height: number; file: string }>();
const savedEntries = manifest.entries.filter((value: any) => value.success);
assert.ok(savedEntries.length > 0 && savedEntries.length <= 8);
for (const entry of savedEntries) {
  const file = resolve(dirname(manifestPath), entry.file); assert.equal(dirname(file), dirname(manifestPath));
  const body = await readFile(file); assert.equal(sha256(body), entry.hash); assert.equal(body.length, entry.bytes);
  const raster = rasterMetadata(body, entry.contentType); assert.deepEqual(raster, entry.raster);
  images.set(entry.url, { body, mime: raster.mime, hash: entry.hash, width: entry.dimensions.width, height: entry.dimensions.height, file });
}
assert.ok(images.size > 0 && images.size <= 8);
const placeholder = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4e8"/></svg>';
const posterUrls = new Set<string>(info.snapshot.performances.flatMap((item: any) => { try { return [new URL(item.poster).href]; } catch { return []; } }));
const byId = new Map<number, any>(info.snapshot.performances.map((item: any) => [item.id, item]));
const dates = { from: info.snapshot.coverage.from, to: info.snapshot.coverage.to };
const ordered = [...info.snapshot.performances].filter((item: any) => item.endDate >= dates.from && item.startDate <= dates.to)
  .sort((a: any, b: any) => b.startDate.localeCompare(a.startDate) || b.id - a.id);
assert.equal(ordered.length, info.count);
const located = (item: any) => item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
  && item.latitude >= 33 && item.latitude <= 39 && item.longitude >= 124 && item.longitude <= 132;
const locatedCount = ordered.filter(located).length;
const sourceCounts = { kopis: ordered.filter((item: any) => item.source === 'kopis').length, culture: ordered.filter((item: any) => item.source === 'culture').length };
await writeFile(samples, '', { flag: 'wx' });

let phase = 'setup', cycles = 0, activeMs = 0, pausedMs = 0, failure: string | undefined, closing = false;
let pendingRoutes = 0, maxPendingRoutes = 0, maxPendingRequests = 0, maxResponseTasks = 0;
let context: BrowserContext | undefined, page: Page | undefined, cdp: CDPSession | undefined;
const started = performance.now();
let activeStartedAt: string | undefined, setupMs: number | undefined, finalVerificationMs: number | undefined, lastProgress = started;
const recent: any[] = [], pendingRequests = new Map<Request, { path: string; phase: string }>(), responseTasks = new Set<Promise<void>>();
const counts = { requests: 0, finished: 0, failed: 0, canceledImages: 0, api: 0, search: 0, map: 0, detail: 0, bootstrap: 0,
  savedRaster: 0, placeholder: 0, abortedImageFulfill: 0, unexpectedExternal: 0, requestOverflow: 0 };
const oracle = new Map<string, string>(), summaries = new Map<string, { count: number; min: number; max: number; sum: number }>();
let firstStable: any, lastStable: any, target: any, group: any[] = [], targetPage = 0, targetOffset = 0;
const fail = (error: unknown) => { failure ??= error instanceof Error ? error.stack ?? error.message : String(error); };
const ensure = () => { if (failure) throw new Error(failure); assert.ok(performance.now() - started < maxWallMs, 'Worker hard wall reached before completion'); };
async function record(kind: string, value: Record<string, unknown> = {}) {
  const row = { at: new Date().toISOString(), kind, phase, cycles, activeMs, pausedMs, wallMs: performance.now() - started, ...value };
  recent.push(row); if (recent.length > LIMITS.recent) recent.shift(); assert.ok(recent.length <= LIMITS.recent);
  await appendFile(samples, JSON.stringify(row) + '\n');
}
const apiKey = (value: URL) => { const query = new URLSearchParams(value.search); query.sort(); return value.pathname + '?' + query; };
function validatePayload(path: URL, payload: any, bytes: Buffer) {
  if (path.pathname === '/api/bootstrap') {
    for (const source of ['kopis', 'culture'] as const) assert.equal(payload.sources.find((value: any) => value.source === source).count, sourceCounts[source]);
    return;
  }
  if (path.pathname === '/api/map' || path.pathname === '/api/performances') {
    for (const filter of ['q', 'cities', 'source', 'genre', 'status', 'price', 'age']) assert.equal(path.searchParams.get(filter) ?? '', '');
    assert.equal(path.searchParams.get('from'), dates.from); assert.equal(path.searchParams.get('to'), dates.to);
    assert.equal(payload.total, info.count); assert.deepEqual(payload.sourceCounts, sourceCounts);
    const expected = path.pathname === '/api/map' ? ordered : ordered.slice((payload.page - 1) * 30, payload.page * 30);
    assert.deepEqual(payload.items.map((item: any) => item.id), expected.map((item: any) => item.id));
    assert.equal(payload.snapshotAt, info.snapshot.snapshotAt);
    if (path.pathname === '/api/map') { assert.equal(payload.truncated, false); assert.ok(bytes.length <= 3 * 1024 * 1024); }
  } else if (/^\/api\/performances\/\d+$/.test(path.pathname)) {
    const expected = byId.get(Number(path.pathname.split('/').at(-1))); assert.ok(expected);
    for (const field of ['id', 'title', 'venue', 'source', 'sourceId']) assert.equal(payload[field], expected[field]);
  } else return;
  const key = apiKey(path), hash = sha256(bytes);
  if (oracle.has(key)) assert.equal(hash, oracle.get(key), 'Repeated complete API wire unchanged');
  else { assert.ok(oracle.size < LIMITS.oracleKeys); oracle.set(key, hash); }
  assert.ok(oracle.size <= LIMITS.oracleKeys);
}
async function observeApi(response: Response) {
  const path = new URL(response.url());
  if (path.origin !== url || !path.pathname.startsWith('/api/')) return;
  assert.equal(response.status(), 200, path.pathname); counts.api++;
  if (path.pathname === '/api/map') counts.map++;
  else if (path.pathname === '/api/performances') counts.search++;
  else if (/^\/api\/performances\/\d+$/.test(path.pathname)) counts.detail++;
  else if (path.pathname === '/api/bootstrap') counts.bootstrap++;
  if (['/api/map', '/api/performances', '/api/bootstrap'].includes(path.pathname) || /^\/api\/performances\/\d+$/.test(path.pathname)) {
    const bytes = await response.body(); validatePayload(path, JSON.parse(bytes.toString('utf8')), bytes);
  }
}
async function drain() {
  const until = performance.now() + 10_000;
  while (pendingRequests.size || pendingRoutes || responseTasks.size) {
    ensure(); assert.ok(performance.now() < until, 'Requests/routes/response validation did not drain');
    if (responseTasks.size) await deadline(Promise.all([...responseTasks]), 'API validation drain', 5000);
    await delay(25);
  }
}
async function stable() {
  ensure(); await page!.waitForFunction(() => document.querySelector('.results')?.getAttribute('aria-busy') === 'false');
  await deadline(page!.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))), 'Two-frame layout observation', 3000);
  ensure();
}
async function popupIds() { return page!.locator('.map-popup-show').evaluateAll(nodes => nodes.map(node => Number((node as HTMLElement).dataset.performanceId))); }
async function popupState() {
  return page!.evaluate(() => ({ ids: [...document.querySelectorAll<HTMLElement>('.map-popup-show')].map(node => Number(node.dataset.performanceId)),
    query: document.querySelector<HTMLInputElement>('.map-popup-search input')?.value,
    page: document.querySelector('.map-popup-page')?.textContent,
    popups: document.querySelectorAll('.leaflet-popup').length }));
}
async function focusId(id: number) { await page!.waitForFunction(value => (document.activeElement as HTMLElement)?.dataset.performanceId === String(value), id); }
function rendererLoad(values: Record<string, number>) {
  const load = { task: values.TaskDuration, script: values.ScriptDuration, layout: values.LayoutDuration, recalcStyle: values.RecalcStyleDuration };
  for (const value of Object.values(load)) assert.ok(Number.isFinite(value));
  return load;
}
async function rendererCounters() {
  const metrics = await deadline(cdp!.send('Performance.getMetrics'), 'Renderer cycle counters', 5000);
  return rendererLoad(Object.fromEntries(metrics.metrics.map(value => [value.name, value.value])));
}
async function sample(label: string) {
  ensure(); const memory = await deadline(cdp!.send('Memory.getDOMCounters'), 'DOM counters', 5000);
  const metrics = await deadline(cdp!.send('Performance.getMetrics'), 'Renderer metrics', 5000);
  const values = Object.fromEntries(metrics.metrics.map(value => [value.name, value.value]));
  const dom = await page!.evaluate(() => ({ nodes: document.querySelectorAll('*').length, maps: document.querySelectorAll('.leaflet-container').length,
    markers: document.querySelectorAll('.venue-map-marker,.venue-cluster-marker,.city-map-marker').length,
    markerItems: [...document.querySelectorAll<HTMLElement>('[data-performance-count]')].reduce((sum, node) => sum + Number(node.dataset.performanceCount), 0),
    popups: document.querySelectorAll('.leaflet-popup').length, popupRows: document.querySelectorAll('.map-popup-show').length,
    dialogs: document.querySelectorAll('dialog[open]').length, total: Number(document.querySelector('.result-total')?.textContent?.replaceAll(',', '')),
    weak: (window as any).__lifecycle.sample(), timingEntries: performance.getEntries().length }));
  assert.equal(dom.total, info.count); assert.ok(dom.weak.tracked <= LIMITS.weakRefs);
  if (label.startsWith('cards-')) { assert.equal(dom.maps, 0); assert.equal(dom.markers, 0); assert.equal(dom.popups, 0); assert.equal(dom.dialogs, 0); }
  const data = { label, memory, jsHeapUsed: values.JSHeapUsedSize, jsHeapTotal: values.JSHeapTotalSize,
    rendererSeconds: rendererLoad(values), dom,
    pending: { requests: pendingRequests.size, routes: pendingRoutes, apiValidation: responseTasks.size }, counts: { ...counts } };
  if (label === 'cards-unmounted') {
    firstStable ??= data; lastStable = data;
    const bin = Math.floor(activeMs / (5 * 60000));
    for (const [metric, value] of Object.entries({ heap: values.JSHeapUsedSize, nodes: memory.nodes, listeners: memory.jsEventListeners })) {
      assert.ok(Number.isFinite(value)); const key = `${bin}:${metric}`, state = summaries.get(key) ?? { count: 0, min: Infinity, max: -Infinity, sum: 0 };
      state.count++; state.min = Math.min(state.min, value); state.max = Math.max(state.max, value); state.sum += value; summaries.set(key, state);
    }
    assert.ok(summaries.size <= 40, 'Only fixed five-minute bins are retained');
  }
  if (label.startsWith('cards-')) await page!.evaluate(() => performance.clearResourceTimings());
  await record('sample', data);
  return data;
}
async function enterMap() {
  await page!.getByRole('button', { name: '지도 + 목록', exact: true }).click(); await stable();
  await page!.waitForFunction(expected => [...document.querySelectorAll<HTMLElement>('[data-performance-count]')]
    .reduce((sum, node) => sum + Number(node.dataset.performanceCount), 0) === expected, locatedCount);
  await drain();
}
async function locateTarget() {
  const locate = page!.locator('.map-result-list .card-locate').nth(targetOffset);
  assert.ok((await locate.getAttribute('aria-label'))?.includes(target.title)); await locate.click();
  await page!.locator('.map-popup-show').first().waitFor(); await stable(); await focusId(target.id);
  assert.deepEqual(await popupIds(), group.slice(0, 20).map(item => item.id));
}
async function fullPopupScan() {
  const ids: number[] = [], next = page!.locator('.map-popup-pagination button').last();
  for (let index = 0; index < Math.ceil(group.length / 20); index++) {
    ids.push(...await popupIds());
    if (index + 1 < Math.ceil(group.length / 20)) { await next.click(); await focusId(group[(index + 1) * 20].id); }
  }
  assert.deepEqual(ids, group.map(item => item.id));
  return ids;
}
async function unmountMap(): Promise<{ frames: number; elapsedMs: number }> {
  await page!.getByRole('button', { name: '카드', exact: true }).click(); await stable(); await drain();
  // A 600 ms interval alone does not cover 30 RAF retries at a low frame rate.
  // Require both 32 observed callbacks and 600 ms, within the same 3 s deadline.
  // A throttled renderer can fail this observation without proving a product leak.
  const observation = await deadline(page!.evaluate(async () => {
    const start = performance.now(); let frames = 0;
    const assertUnmounted = () => {
      if (document.querySelector('.leaflet-container,.leaflet-popup,.map-popup,dialog[open]')) throw new Error('Map/popup/dialog survived or returned after unmount');
    };
    assertUnmounted();
    while (frames < 32 || performance.now() - start < 600) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      frames++; assertUnmounted();
    }
    return { frames, elapsedMs: performance.now() - start };
  }), 'Unmount observation: at least 32 RAF callbacks and 600 ms', 3000);
  await drain();
  assert.ok(observation.frames >= 32 && observation.elapsedMs >= 600);
  return observation;
}
async function waitForResume() {
  if (!control) return;
  for (;;) {
    ensure(); let paused = false;
    try { paused = JSON.parse((await readFile(control, 'utf8')).replace(/^\uFEFF/, '')).paused === true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!paused) return;
    phase = 'paused'; const pauseStart = performance.now(); await delay(500); pausedMs += performance.now() - pauseStart;
    if (performance.now() - lastProgress >= 30000) { await record('paused'); lastProgress = performance.now(); }
  }
}

const browser = await chromium.connect(process.env.CULTURE_LIFECYCLE_BROWSER_WS!, { timeout: 30_000 });
const cleanup: any[] = [];
try {
  // Only the harness-owned loopback origin is fetched; production responses are not replaced.
  const initialResponse = await fetch(`${url}/api/map?${new URLSearchParams(dates)}`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(initialResponse.status, 200);
  const initialBytes = Buffer.from(await initialResponse.arrayBuffer()), initialMap = JSON.parse(initialBytes.toString('utf8'));
  validatePayload(new URL(initialResponse.url), initialMap, initialBytes);
  const groups = new Map<string, any[]>();
  for (const item of initialMap.items.filter(located)) {
    const key = `${item.latitude.toFixed(5)},${item.longitude.toFixed(5)}`, rows = groups.get(key) ?? []; rows.push(item); groups.set(key, rows);
  }
  const largest = [...groups.values()].sort((a, b) => b.length - a.length).slice(0, 2);
  assert.deepEqual(largest.map(rows => rows.length), [210, 112]);
  // Both keep the unchanged national map. Choose the closest real list-page entry
  // only to bound setup navigation, not to inject a synthetic search response.
  const choices = largest.map(rows => ({ rows, rank: ordered.findIndex((item: any) => item.id === rows[0].id) }))
    .sort((a, b) => a.rank - b.rank);
  group = choices[0].rows; target = group[0]; targetPage = Math.floor(choices[0].rank / 30) + 1; targetOffset = choices[0].rank % 30;
  assert.ok(targetPage <= 20, 'Real dense group requires more than the bounded 20-page setup; revise before soak');
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', fail); page.on('crash', () => fail('Renderer crashed')); browser.on('disconnected', () => { if (!closing) fail('Browser disconnected'); });
  page.on('request', request => {
    try {
      assert.ok(pendingRequests.size < LIMITS.requests, 'Pending request cap reached');
      pendingRequests.set(request, { path: new URL(request.url()).pathname, phase }); counts.requests++;
      maxPendingRequests = Math.max(maxPendingRequests, pendingRequests.size); assert.ok(pendingRequests.size <= LIMITS.requests);
    } catch (error) { counts.requestOverflow++; fail(error); }
  });
  page.on('requestfinished', request => { pendingRequests.delete(request); counts.finished++; });
  page.on('requestfailed', request => {
    pendingRequests.delete(request); counts.failed++;
    // Leaflet may discard an old tile during locate/zoom/unmount. This is a
    // completed cancellation, not an API failure; retain only its scalar count.
    if (request.resourceType() === 'image' && request.failure()?.errorText === 'net::ERR_ABORTED') counts.canceledImages++;
    else if (!closing) fail(`${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on('response', response => {
    if (new URL(response.url()).origin !== url || !new URL(response.url()).pathname.startsWith('/api/')) return;
    if (responseTasks.size >= LIMITS.responseTasks) { fail('Response validation task cap reached'); return; }
    const task = observeApi(response).catch(fail); responseTasks.add(task); maxResponseTasks = Math.max(maxResponseTasks, responseTasks.size);
    void task.finally(() => responseTasks.delete(task));
    try { assert.ok(responseTasks.size <= LIMITS.responseTasks); } catch (error) { fail(error); }
  });
  await page.addInitScript('globalThis.__name = function(value) { return value; };');
  await page.addInitScript(({ dates, cap }) => {
    (window as any).__CULTURE_PERFORMANCE__ = false;
    localStorage.setItem('culture-desk.filters.v3', JSON.stringify({ cities: [], ...dates, genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30 }));
    performance.setResourceTimingBufferSize(150);
    const seen = new WeakSet<Element>(), refs: { value: WeakRef<Element>; at: number; kind: string }[] = [];
    let observed = 0, dropped = 0, collectedObserved = 0;
    const remember = (node: Element) => {
      if (seen.has(node)) return; seen.add(node); observed++;
      if (refs.length === cap) { refs.shift(); dropped++; }
      refs.push({ value: new WeakRef(node), at: performance.now(), kind: node.classList.contains('map-popup') ? 'popup' : 'map' });
      if (refs.length > cap) throw new Error('WeakRef candidate ring exceeded bound');
    };
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) if (node instanceof Element) {
        if (node.matches('.leaflet-container,.map-popup')) remember(node);
        for (const child of node.querySelectorAll('.leaflet-container,.map-popup')) remember(child);
      }
    });
    observer.observe(document, { subtree: true, childList: true });
    (window as any).__lifecycle = {
      sample: () => {
        let detached = 0, connected = 0, oldestDetachedMs = 0;
        for (let index = refs.length - 1; index >= 0; index--) {
          const node = refs[index].value.deref();
          if (!node) { refs.splice(index, 1); collectedObserved++; }
          else if (node.isConnected) connected++;
          else { detached++; oldestDetachedMs = Math.max(oldestDetachedMs, performance.now() - refs[index].at); }
        }
        if (refs.length > cap) throw new Error('WeakRef candidate ring exceeded bound');
        return { tracked: refs.length, observed, dropped, collectedObserved, detached, connected, oldestDetachedMs, cap };
      },
      stop: () => { observer.disconnect(); refs.length = 0; },
    };
  }, { dates, cap: LIMITS.weakRefs });
  await page.route('**/*', async route => {
    if (pendingRoutes >= LIMITS.routes) { fail('Pending route cap reached'); await route.abort().catch(() => {}); return; }
    pendingRoutes++; maxPendingRoutes = Math.max(maxPendingRoutes, pendingRoutes);
    const request = route.request();
    let operation: 'not-started' | 'continue' | 'fulfill' = 'not-started';
    try {
      assert.ok(pendingRoutes <= LIMITS.routes);
      const requestUrl = new URL(request.url());
      if (requestUrl.origin === url) { assert.ok(['GET', 'HEAD'].includes(request.method())); operation = 'continue'; await route.continue(); }
      else if (request.resourceType() === 'image' && images.has(request.url())) {
        const saved = images.get(request.url())!; counts.savedRaster++;
        operation = 'fulfill';
        await route.fulfill({ contentType: saved.mime, body: saved.body });
      } else if (request.resourceType() === 'image' && (posterUrls.has(request.url()) || requestUrl.hostname === 'tile.openstreetmap.org')) {
        counts.placeholder++; operation = 'fulfill'; await route.fulfill({ contentType: 'image/svg+xml', body: placeholder });
      } else { counts.unexpectedExternal++; throw new Error(`Unexpected external request: ${requestUrl.origin}${requestUrl.pathname}`); }
    } catch (error) {
      // Accept only an allowed image's fulfill race with an independently
      // observed terminal Chromium abort on that same Request. Neither an
      // unconfirmed error message nor an API/continue error is sufficient.
      const confirmedAbort = operation === 'fulfill' && request.resourceType() === 'image'
        && request.failure()?.errorText === 'net::ERR_ABORTED';
      if (confirmedAbort) {
        counts.abortedImageFulfill++;
        await record('confirmed-image-fulfill-abort', { path: new URL(request.url()).pathname,
          requestError: request.failure()?.errorText, fulfillError: String(error).slice(0, 1000) }).catch(fail);
      }
      else if (!closing) fail(error);
      await route.abort('blockedbyclient').catch(() => {});
    }
    finally { pendingRoutes--; }
  });
  cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await stable(); await drain();
  // Saved image decode is checked where an acquired URL is present; other posters
  // intentionally use the declared local substitute, not live image acquisition.
  // Lazy image requests can begin after an otherwise drained API/layout frame.
  // Wait for an actual saved raster in the DOM rather than treating that gap as
  // proof that no replayed image loaded; this wait never fetches extra assets.
  await page.waitForFunction(savedUrls => [...document.querySelectorAll<HTMLImageElement>('.card-art img')]
    .some(image => savedUrls.includes(image.src) && image.complete && image.naturalWidth > 0), [...images.keys()], { timeout: 10_000 });
  await drain();
  const decodedSaved = await deadline(page.evaluate(async entries => {
    const found = [...document.querySelectorAll<HTMLImageElement>('.card-art img')].filter(image => entries.some(entry => entry.url === image.src));
    // Lazy card images below the viewport need not load. Observe the matching
    // loaded rasters and require at least one actual decode, without scrolling
    // or retaining image handles solely for the fixture.
    const loaded = found.filter(image => image.complete && image.naturalWidth > 0);
    for (const image of loaded) {
      await image.decode(); const entry = entries.find(value => value.url === image.src)!;
      if (image.naturalWidth !== entry.width || image.naturalHeight !== entry.height) throw new Error('Saved raster dimensions changed');
    }
    return loaded.map(image => image.src);
  }, [...images].map(([imageUrl, value]) => ({ url: imageUrl, width: value.width, height: value.height }))), 'Saved raster decode', 10_000);
  assert.ok(decodedSaved.length > 0, 'At least one saved raster is actually replayed/decoded');
  for (let selectedPage = 1; selectedPage < targetPage; selectedPage++) {
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/performances' && new URL(value.url()).searchParams.get('page') === String(selectedPage + 1));
    await page.getByRole('navigation', { name: '검색 결과 페이지' }).getByRole('button', { name: '다음 페이지', exact: true }).click();
    await response; await stable(); await drain();
  }
  await record('prepared', { target: { id: target.id, title: target.title, page: targetPage, offset: targetOffset, groupRows: group.length },
    groupIds: group.map(item => item.id), decodedSaved, limits: LIMITS });
  setupMs = performance.now() - started; activeStartedAt = new Date().toISOString();
  // Keep the pre-map/module-load baseline separate from the repeated, warmed
  // cards-unmounted states used for five-minute natural-GC observations.
  await sample('cards-before-map');
  while (mode === 'smoke' ? cycles < 3 : activeMs < 60 * 60000) {
    ensure(); assert.ok(cycles < LIMITS.cycles, 'Cycle safety cap reached before requested active duration');
    await waitForResume();
    phase = 'cycle'; const cycleStart = performance.now(), countsBefore = { ...counts }, cycleCpu = process.cpuUsage(); cycles++;
    const rendererBefore = await rendererCounters();
    await enterMap();
    if (cycles === 1 || cycles % 5 === 0) await sample('map-ready');
    await locateTarget();
    const search = page.locator('.map-popup-search input');
    const next = page.locator('.map-popup-pagination button').last(), previous = page.locator('.map-popup-pagination button').first();
    const localBefore = { search: counts.search, map: counts.map };
    const allPages = cycles === 1 || cycles % 20 === 0 || (mode === 'smoke' && cycles === 3);
    if (allPages) {
      await fullPopupScan();
      await search.fill('lifecycle-reset-no-match'); await search.fill(''); await stable();
    } else {
      await next.click(); await focusId(group[20].id); assert.deepEqual(await popupIds(), group.slice(20, 40).map(item => item.id));
      await previous.click(); await focusId(group[0].id);
    }
    await search.fill(group[0].title); await stable();
    const term = group[0].title.normalize('NFC').toLocaleLowerCase('ko-KR');
    assert.deepEqual(await popupIds(), group.filter(item => [item.title, item.venue].some(value => value.normalize('NFC').toLocaleLowerCase('ko-KR').includes(term)))
      .slice(0, 20).map(item => item.id));
    await search.fill('lifecycle-no-match-987654321'); assert.deepEqual(await popupIds(), []);
    await search.fill(''); await next.click(); await focusId(group[20].id);
    const selected = group[20 + (cycles % Math.min(20, group.length - 20))];
    const row: Locator = page.locator(`.map-popup-show[data-performance-id="${selected.id}"]`);
    const handle: ElementHandle<SVGElement | HTMLElement> | null = await row.elementHandle(); assert.ok(handle);
    try {
      const detailRequest = page.waitForResponse(value => new URL(value.url()).pathname === `/api/performances/${selected.id}`);
      await row.click(); await detailRequest;
      const dialog = page.getByRole('dialog', { name: selected.title, exact: true }); await dialog.waitFor();
      assert.ok((await dialog.textContent())?.includes(selected.venue));
      await dialog.getByRole('button', { name: '닫기', exact: true }).click(); await focusId(selected.id);
      assert.equal(await handle.evaluate((node: Element) => node.isConnected && node === document.activeElement), true);
    } finally { await handle.dispose(); }
    await drain(); assert.deepEqual({ search: counts.search, map: counts.map }, localBefore, 'Popup local actions never refetch the result set');
    const beforeReopen = await popupState(); await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.leaflet-popup') && document.activeElement?.classList.contains('venue-map-marker'));
    await page.keyboard.press('Enter'); await page.locator('.map-popup').waitFor(); await focusId(selected.id);
    assert.deepEqual(await popupState(), beforeReopen, 'Reopen preserves the local page/query/member order');
    if (cycles === 1 || cycles % 5 === 0) await sample('popup-open');
    const unmountObservation = await unmountMap();
    const actionsCompleted = performance.now(); activeMs += actionsCompleted - cycleStart;
    const cardSample = await sample('cards-unmounted'); await drain();
    const rendererDeltaSeconds = Object.fromEntries(Object.entries(rendererBefore)
      .map(([key, before]) => [key, cardSample.rendererSeconds[key as keyof typeof rendererBefore] - before]));
    for (const value of Object.values(rendererDeltaSeconds)) assert.ok(Number.isFinite(value) && value >= 0);
    await record('cycle-complete', { cycleMs: performance.now() - cycleStart, allPages, requestsDelta: counts.requests - countsBefore.requests,
      apiDelta: counts.api - countsBefore.api, workerCpuDeltaMicroseconds: process.cpuUsage(cycleCpu), rendererDeltaSeconds,
      unmountObservation, workerMemory: process.memoryUsage() });
    activeMs += performance.now() - actionsCompleted;
    if (mode === 'smoke' || performance.now() - lastProgress >= 60000) {
      console.log(JSON.stringify({ type: 'lifecycle-progress', mode, cycles, activeMs, pausedMs, pending: pendingRequests.size })); lastProgress = performance.now();
    }
  }
  if (mode === 'soak') {
    // The cycle that crosses sixty active minutes is not predictable. Perform
    // a fresh explicit full scan afterward rather than relabeling an earlier one.
    await waitForResume(); phase = 'final-verification'; const finalStart = performance.now();
    assert.ok(activeMs >= 60 * 60000); await enterMap(); await locateTarget();
    const localBefore = { search: counts.search, map: counts.map };
    const ids = await fullPopupScan(); await drain();
    assert.deepEqual({ search: counts.search, map: counts.map }, localBefore, 'Final full popup scan stays local');
    const unmountObservation = await unmountMap(); await sample('cards-final-verification'); await drain();
    finalVerificationMs = performance.now() - finalStart;
    // Explicitly excluded from activeMs: that counter already reached sixty
    // minutes. Wall time and this separate duration include the final check.
    await record('final-verification-complete', { finalVerificationMs, includedInActiveMs: false, ids, unmountObservation });
  }
  ensure(); assert.equal(counts.unexpectedExternal, 0); assert.equal(counts.requestOverflow, 0);
  if (mode === 'smoke') assert.equal(cycles, 3); else assert.ok(activeMs >= 60 * 60000);
} catch (error) { fail(error); }
finally {
  phase = 'cleanup'; closing = true;
  try { await record('before-cleanup', { failure, pendingRequests: pendingRequests.size, pendingRoutes, responseTasks: responseTasks.size }); }
  catch (error) { fail(error); }
  try { if (page && !page.isClosed()) await deadline(page.evaluate(() => (window as any).__lifecycle?.stop()), 'Observer disconnect', 3000); }
  catch (error) { fail(error); cleanup.push({ action: 'observer.disconnect', error: String(error) }); }
  try { await deadline(cdp?.detach() ?? Promise.resolve(), 'CDP detach', 3000); cleanup.push({ action: 'cdp.detach', success: true }); }
  catch (error) { fail(error); cleanup.push({ action: 'cdp.detach', error: String(error) }); }
  try { await deadline(context?.close() ?? Promise.resolve(), 'Context close', 5000); cleanup.push({ action: 'context.close', success: true }); }
  catch (error) { fail(error); cleanup.push({ action: 'context.close', error: String(error) }); }
  try {
    await deadline((async () => {
      while (pendingRoutes || responseTasks.size) {
        if (responseTasks.size) await Promise.all([...responseTasks]);
        await delay(25);
      }
    })(), 'Route/response tasks after context close', 5000);
    assert.equal(pendingRoutes, 0); assert.equal(responseTasks.size, 0);
    // Chromium may omit terminal events on context teardown. Preserve the count
    // before releasing Request references; the already-completed cycles require zero.
    cleanup.push({ action: 'request-reference-release', contextClosedPending: pendingRequests.size }); pendingRequests.clear();
    await deadline(browser.close(), 'Worker browser connection close', 5000);
  } catch (error) { fail(error); }
  try { for (const saved of images.values()) assert.equal(sha256(await readFile(saved.file)), saved.hash); }
  catch (error) { fail(error); }
  await writeFile(output, JSON.stringify({ version: 1, mode, success: !failure, failure, activeStartedAt, endedAt: new Date().toISOString(),
    cycles, activeMs, pausedMs, setupMs, finalVerificationMs, finalVerificationIncludedInActiveMs: false,
    wallMs: performance.now() - started, requestedActiveMs: mode === 'smoke' ? null : 60 * 60000,
    environment: { node: process.version, platform: process.platform, arch: process.arch, browser: browser.version() },
    scope: 'One context/page with natural GC. CDP DOM counters may include uncollected detached nodes. Bounded WeakRefs observe candidates only; no heap snapshot, forced GC or no-leak assertion. Real national API responses are unchanged. Saved matching posters are exact local bytes; all other known posters/tiles are declared local SVG substitutes. Worker CPU excludes Chromium and fixture CPU.',
    snapshot: { hash: info.hash, rows: info.count }, manifestHash: sha256(manifestBytes), limits: LIMITS,
    target: target && { id: target.id, page: targetPage, offset: targetOffset, groupRows: group.length }, counts,
    maxima: { pendingRequests: maxPendingRequests, pendingRoutes: maxPendingRoutes, responseTasks: maxResponseTasks },
    pendingAfterCleanup: { requests: pendingRequests.size, routes: pendingRoutes, responseTasks: responseTasks.size },
    oracleHashes: Object.fromEntries(oracle), firstStable, lastStable, fiveMinuteBins: Object.fromEntries(summaries), cleanup, recent, samples }, null, 2) + '\n', { flag: 'wx' });
}
if (failure) process.exitCode = 1;
