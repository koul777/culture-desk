import { chromium, devices, type Page } from '@playwright/test';
import { basename, resolve } from 'node:path';
import { argumentsOf, clientFingerprint, saveJson, snapshotInfo, sourceFingerprint, statistics, workspace } from './common.js';
import { startBrowserFixture } from './browser-fixture.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
if (!args.out) throw new Error('--out is required');
const samples = Number(args.samples ?? '3');
const warmup = Number(args.warmup ?? (args['compare-root'] ? '2' : '0'));
const device = args.device ?? 'desktop';
const scenarios = (args.scenarios ?? 'cards,direct-map,cards-to-map').split(',');
const profile = args.profile ?? 'local';
if (!['desktop', 'mobile'].includes(device) || !['local', 'limited'].includes(profile)) throw new Error('Invalid browser profile');
if (!Number.isInteger(samples) || samples < 1 || samples > 200 || !Number.isInteger(warmup) || warmup < 0 || warmup > 10 || scenarios.some(value => !['cards', 'direct-map', 'cards-to-map'].includes(value))) throw new Error('Invalid sample count or scenario');
const outputDirectory = resolve(args.out, '..');
const definitions = args['compare-root'] ? [{ name: 'baseline', root }, { name: 'candidate', root: resolve(args['compare-root']) }] : [{ name: args.variant ?? 'candidate', root }];
const variants: any[] = [];
try {
  for (const variant of definitions) {
    const info = await snapshotInfo(variant.root, args.snapshot);
    const sourceBefore = await sourceFingerprint(variant.root), buildBefore = await clientFingerprint(variant.root);
    const fixture = await startBrowserFixture(variant.root, args.cache ?? 'miss', args.snapshot);
    const knownPosterHosts = new Set<string>(info.snapshot.performances.filter((row: any) => row.poster).flatMap((row: any) => {
      try { return [new URL(row.poster).hostname]; } catch { return []; }
    }));
    variants.push({ ...variant, info, sourceBefore, buildBefore, fixture, ready: fixture.ready, knownPosterHosts });
  }
  if (new Set(variants.map(variant => variant.info.hash)).size !== 1) throw new Error('Browser comparison snapshot corpora differ');
} catch (error) { await Promise.all(variants.map(variant => variant.fixture.stop())); throw error; }
const browser = await chromium.launch().catch(async error => { await Promise.all(variants.map(variant => variant.fixture.stop())); throw error; });
const raw: any[] = [], discarded: any[] = [];
const summary = (rows: any[]) => variants.flatMap(variant => scenarios.map(scenario => {
  const selected = rows.filter(row => row.variant === variant.name && row.scenario === scenario);
  return { variant: variant.name, scenario, ...(selected.length ? statistics(selected.map(row => row.actionToReadyMs)) : { samples: 0 }) };
}));
const posterSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#8b9ba5"/><text x="25" y="225" fill="white">OFFLINE POSTER</text></svg>';
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4e8"/></svg>';

async function settled(page: Page, map: any | undefined) {
  if (map) {
    const located = map.items.filter((item: any) => item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
      && item.latitude >= 33 && item.latitude <= 39 && item.longitude >= 124 && item.longitude <= 132).length;
    await page.waitForFunction(({ located, count }) => {
      const markerTotal = [...document.querySelectorAll<HTMLElement>('[data-performance-count]')].reduce((sum, node) => sum + Number(node.dataset.performanceCount), 0);
      const scopeText = document.querySelector('.map-scope-note')?.textContent ?? '';
      return markerTotal === located && scopeText.includes(`검색 결과 ${count.toLocaleString('ko-KR')}건`)
        && !!document.querySelector('.leaflet-container') && document.querySelector('.results')?.getAttribute('aria-busy') === 'false';
    }, { located, count: map.items.length });
  } else {
    await page.waitForFunction(() => document.querySelector('.results')?.getAttribute('aria-busy') === 'false'
      && document.querySelectorAll('.performance-grid .performance-card').length > 0);
  }
  return page.evaluate(() => new Promise<number>((resolveReady, rejectReady) => {
    let stableFrames = 0, changed = false;
    let frame = 0;
    const target = document.querySelector('.leaflet-marker-pane') ?? document.querySelector('.performance-grid');
    const observer = new MutationObserver(() => { changed = true; });
    if (target) observer.observe(target, { childList: true, subtree: true, attributes: true });
    const cleanup = () => { observer.disconnect(); clearTimeout(deadline); cancelAnimationFrame(frame); };
    const deadline = setTimeout(() => { cleanup(); rejectReady(new Error('Result DOM did not reach two stable animation frames within 5 seconds')); }, 5000);
    const tick = () => {
      if (changed) { stableFrames = 0; changed = false; } else stableFrames++;
      if (stableFrames >= 2) { cleanup(); resolveReady(performance.now()); } else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }));
}

try {
  for (const scenario of scenarios) for (let index = -warmup; index < samples; index++) {
    const order = Math.abs(index) % 2 === 0 ? variants : [...variants].reverse();
    for (const variant of order) {
    const { info, ready, knownPosterHosts } = variant;
    const context = await browser.newContext({ ...(device === 'mobile' ? devices['Pixel 7'] : devices['Desktop Chrome']),
      viewport: device === 'mobile' ? { width: 375, height: 812 } : { width: 1440, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors: string[] = [], unexpected: string[] = [], network: any[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // tsx keeps nested function names with this helper when Playwright serializes callbacks.
    await page.addInitScript('globalThis.__name = function(value) { return value; };');
    await page.addInitScript(({ from, to }) => {
      (window as any).__CULTURE_PERFORMANCE__ = true;
      localStorage.setItem('culture-desk.filters.v3', JSON.stringify({ cities: [], from, to, genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30 }));
      (window as any).__longTasks = [];
      try { new PerformanceObserver(list => (window as any).__longTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true }); } catch {}
    }, { from: info.snapshot.coverage?.from ?? '2026-10-01', to: info.snapshot.coverage?.to ?? '2027-01-17' });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === ready.url) return route.continue();
      if (url.hostname === 'tile.openstreetmap.org') return route.fulfill({ contentType: 'image/svg+xml', body: tileSvg });
      if (route.request().resourceType() === 'image' && knownPosterHosts.has(url.hostname)) return route.fulfill({ contentType: 'image/svg+xml', body: posterSvg });
      unexpected.push(`${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
    });
    page.on('response', response => {
      if (new URL(response.url()).origin !== ready.url) return;
      network.push({ url: new URL(response.url()).pathname + new URL(response.url()).search, status: response.status(),
        handlerMs: response.headers()['x-performance-handler-ms'], cache: response.headers()['x-performance-cache'], encoding: response.headers()['content-encoding'] });
    });
    const cdp = await context.newCDPSession(page);
    if (profile === 'limited') {
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    try {
      const mapResponse = scenario === 'direct-map' ? page.waitForResponse(response => new URL(response.url()).pathname === '/api/map') : undefined;
      const searchResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/performances');
      await page.goto(`${ready.url}/${scenario === 'direct-map' ? '#map' : ''}`, { waitUntil: 'domcontentloaded' });
      const searched = await (await searchResponse).json();
      let map = mapResponse ? await (await mapResponse).json() : undefined;
      let actionStartMs = 0;
      if (scenario === 'cards-to-map') {
        await settled(page, undefined);
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/map');
        actionStartMs = await page.evaluate(() => performance.now());
        await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
        map = await (await response).json();
      }
      const readyMs = await settled(page, map);
      const metrics = await page.evaluate(() => ({
        navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()),
        resources: performance.getEntriesByType('resource').map(entry => entry.toJSON()),
        marks: performance.getEntries().filter(entry => entry.name.startsWith('culture:')).map(entry => ({ ...entry.toJSON(), detail: (entry as PerformanceMark | PerformanceMeasure).detail })),
        longTasks: (window as any).__longTasks,
        markerCount: document.querySelectorAll('[data-performance-count]').length,
        markerTotal: [...document.querySelectorAll<HTMLElement>('[data-performance-count]')].reduce((sum, node) => sum + Number(node.dataset.performanceCount), 0),
        cardCount: document.querySelectorAll('.performance-card').length,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }));
      if (errors.length || unexpected.length || metrics.overflow > 1) throw new Error(JSON.stringify({ errors, unexpected, overflow: metrics.overflow }));
      if (map && map.total !== searched.total) throw new Error(`Map/list totals differ: ${map.total}/${searched.total}`);
      if (searched.partial && !(await page.locator('.coverage-note').isVisible())) throw new Error('Partial coverage is not disclosed');
      if (map?.truncated && !(await page.locator('.map-scope-note').textContent())?.includes(`전체 ${map.total.toLocaleString('ko-KR')}건 중 일부`)) throw new Error('Map truncation is not disclosed');
      if (index === 0) await page.screenshot({ path: resolve(outputDirectory, `${basename(args.out, '.json')}-${variant.name}-${device}-${scenario}.png`) });
      (index < 0 ? discarded : raw).push({ variant: variant.name, scenario, index, device, profile, readyMs, actionStartMs, actionToReadyMs: readyMs - actionStartMs,
        searchTotal: searched.total, searchPartial: searched.partial, pendingDetails: searched.pendingDetails, snapshotAt: searched.snapshotAt,
        mapTotal: map?.total, mapItems: map?.items.length, mapPartial: map?.partial, mapTruncated: map?.truncated, errors, unexpected, network, ...metrics });
    } finally { await context.close(); }
    }
    if (index >= 0 && (index + 1) % 10 === 0) {
      await saveJson(args.out + '.partial.json', { complete: false, scenario, completedPairs: index + 1, summary: summary(raw), raw });
      console.log(JSON.stringify({ scenario, completedPairs: index + 1, totalPairs: samples }));
    }
  }
} catch (error) {
  await saveJson(args.out + '.failure.json', { measuredAt: new Date().toISOString(), variant: args.variant, root, device, profile, raw, discarded,
    error: String(error), stderr: variants.map(variant => ({ variant: variant.name, stderr: variant.fixture.stderr() })) });
  throw error;
} finally { try { await browser.close(); } finally { await Promise.all(variants.map(variant => variant.fixture.stop())); } }
const sources = [];
for (const variant of variants) {
  const sourceAfter = await sourceFingerprint(variant.root), buildAfter = await clientFingerprint(variant.root);
  sources.push({ variant: variant.name, root: variant.root, before: variant.sourceBefore, afterHash: sourceAfter.hash, stable: variant.sourceBefore.hash === sourceAfter.hash,
    build: { before: variant.buildBefore, afterHash: buildAfter.hash, stable: variant.buildBefore.hash === buildAfter.hash } });
}
const info = variants[0].info;
const report = { version: 2, measuredAt: new Date().toISOString(), variant: args.variant ?? root, variants: definitions, browser: browser.version(), device, profile,
  scope: 'Fresh browser contexts with fixed saved full-coverage date filters; prepared backend model/router; explicit cache mode; gzip HTTP. Real snapshot content/coordinates. External poster and map tile images are deterministic local SVG substitutes, not live image/network/GPU validation.',
  fixtures: variants.map(variant => ({ variant: variant.name, ...variant.ready })), snapshot: { hash: info.hash, bytes: info.bytes, performances: info.count }, samples, warmup,
  ordering: 'Sequential AB/BA pairs for each scenario; fresh context every sample; two prepared fixture processes; no overlapping browser samples.',
  ambientEvidence: args['ambient-evidence'] ?? null, source: sources,
  summary: summary(raw), timeBlocks: [0, 1, 2].map(block => ({ block: block + 1, summary: summary(raw.filter(row => Math.floor(row.index * 3 / samples) === block)) })), discarded, raw };
await saveJson(args.out, report);
if (sources.some(source => !source.stable || !source.build.stable)) throw new Error('Source/build changed during browser measurements; report is not an acceptance run');
console.log(JSON.stringify({ out: args.out, summary: report.summary }, null, 2));
