import assert from 'node:assert/strict';
import { devices, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { argumentsOf, clientFingerprint, saveJson, sha256, snapshotInfo, sourceFingerprint, statistics, workspace } from './common.js';
import { startBrowserFixture } from './browser-fixture.js';
import { deadline, launchPosterBrowser, rasterMetadata, routeLedger } from './poster-runtime.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
if (!args.out || !args.manifest || !args['compare-root']) throw new Error('--out, --manifest and --compare-root are required');
const samples = Number(args.samples ?? '10'), warmup = Number(args.warmup ?? '1'), device = args.device ?? 'desktop';
const cpuRate = Number(args['cpu-rate'] ?? (device === 'mobile' ? '4' : '1')), scroll = args.scroll ?? 'none';
if (!['none', 'first-result'].includes(scroll)) throw new Error('--scroll must be none or first-result');
if (!['desktop', 'mobile'].includes(device) || !Number.isInteger(samples) || samples < 1 || samples > 40 || !Number.isInteger(warmup) || warmup < 0 || warmup > 3 || ![1, 4].includes(cpuRate)) throw new Error('Invalid replay profile');
const manifestPath = resolve(args.manifest), manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes.toString('utf8'));
const ambientPath = args['ambient-evidence'] ? resolve(args['ambient-evidence']) : null;
const ambientBytes = ambientPath ? await readFile(ambientPath) : null;
const ambient = ambientBytes ? JSON.parse(ambientBytes.toString('utf8')) : null;
assert.equal(manifest.version, 2); assert.equal(manifest.complete, true, 'Poster acquisition must be complete');
assert.equal(manifest.sourceStable, true); assert.equal(manifest.buildStable, true);
const images = new Map<string, { body: Buffer; contentType: string; hash: string; dimensions: { width: number; height: number } }>();
for (const entry of manifest.entries.filter((entry: any) => entry.success)) {
  const file = resolve(dirname(manifestPath), entry.file);
  assert.equal(dirname(file), dirname(manifestPath), 'Poster file stays beside its manifest');
  const body = await readFile(file); assert.equal(sha256(body), entry.hash, 'Stored poster bytes match acquisition hash');
  assert.equal(body.byteLength, entry.bytes); assert.ok(body.byteLength <= 5 * 1024 * 1024);
  assert.deepEqual(rasterMetadata(body, entry.contentType), entry.raster, 'Saved bytes retain their verified raster signature');
  assert.ok(entry.dimensions.width > 0 && entry.dimensions.height > 0);
  images.set(entry.url, { body, contentType: entry.raster.mime, hash: entry.hash, dimensions: entry.dimensions });
}
assert.ok(images.size > 0 && images.size <= 8, 'One to eight acquired images');
const variants: any[] = [], raw: any[] = [], discarded: any[] = [];
const report: any = { version: 2, complete: false, phase: 'starting', measuredAt: new Date().toISOString(), device, cpuRate, samples, warmup, scroll,
  scenario: scroll === 'none' ? 'initial-cards-viewport' : 'explicit-scroll-to-first-result',
  scope: 'Fresh-context sequential AB/BA cards comparison. Prepared model/router misses verified from observed producer headers. Visible posters use exact signature-verified saved raster bytes, served locally without Internet latency/throughput emulation. Explicit scroll is not an initial-viewport claim. Other known posters use SVG substitutes. Visual readiness awaits decode and stable image/card rectangles; post-DOM wait is not isolated decoder CPU time. Opt-in application instrumentation is disabled.',
  manifest: { path: manifestPath, hash: sha256(manifestBytes), snapshot: manifest.snapshot,
    images: [...images].map(([url, value]) => ({ url, hash: value.hash, bytes: value.body.length, dimensions: value.dimensions })) },
  ambientEvidence: ambientPath && ambientBytes ? { path: ambientPath, hash: sha256(ambientBytes), startedAt: ambient.startedAt, endedAt: ambient.endedAt, summary: ambient.summary } : null,
  sources: [], cleanup: [], persistenceErrors: [], raw, discarded };
const placeholder = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#8b9ba5"/></svg>';

async function cardsReady(page: Page) {
  await page.waitForFunction(() => document.querySelector('.results')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.performance-grid .performance-card').length > 0);
  return deadline(page.evaluate(() => new Promise<number>((resolveReady, reject) => {
    let stableFrames = 0, changed = false, frame = 0;
    const target = document.querySelector('.performance-grid'), observer = new MutationObserver(() => { changed = true; });
    if (target) observer.observe(target, { childList: true, subtree: true, attributes: true });
    const cleanup = () => { observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Card DOM stability exceeded 5 seconds')); }, 5_000);
    const tick = () => {
      if (changed) { stableFrames = 0; changed = false; } else stableFrames++;
      if (stableFrames >= 2) { cleanup(); resolveReady(performance.now()); } else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  })), 'Card DOM readiness', 7_000);
}

let managed: Awaited<ReturnType<typeof launchPosterBrowser>> | undefined, failure: unknown;
async function saveWithoutSkippingCleanup() {
  try { await saveJson(args.out, report); return undefined; }
  catch (error) {
    const evidence = { phase: report.phase, error: String(error), at: new Date().toISOString() };
    report.persistenceErrors.push(evidence); report.complete = false; failure ??= error;
    console.error(JSON.stringify({ type: 'poster-report-save-failed', ...evidence }));
    return error;
  }
}
await saveJson(args.out, report);
try {
  for (const definition of [{ name: 'baseline', root }, { name: 'candidate', root: resolve(args['compare-root']) }]) {
    const info = await snapshotInfo(definition.root);
    assert.equal(info.hash, manifest.snapshot.hash, 'Replay uses the acquisition snapshot');
    const source = await sourceFingerprint(definition.root), build = await clientFingerprint(definition.root);
    const fixture = await startBrowserFixture(definition.root, 'miss');
    const allowed = new Set<string>(info.snapshot.performances.flatMap((row: any) => { try { return [new URL(row.poster).href]; } catch { return []; } }));
    variants.push({ ...definition, info, source, build, fixture, allowed });
    report.sources.push({ variant: definition.name, root: definition.root, sourceBefore: source, buildBefore: build, snapshot: { hash: info.hash, bytes: info.bytes, rows: info.count } });
    await saveJson(args.out, report);
  }
  managed = await launchPosterBrowser(); report.browserVersion = managed.browser.version(); report.ownedBrowserPid = managed.pid;
  for (let index = -warmup; index < samples; index++) for (const variant of Math.abs(index) % 2 === 0 ? variants : [...variants].reverse()) {
    const context: BrowserContext = await deadline(managed.browser.newContext({ ...(device === 'mobile' ? devices['Pixel 7'] : devices['Desktop Chrome']),
      viewport: device === 'mobile' ? { width: 375, height: 812 } : { width: 1440, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' }), 'Replay context');
    const row: any = { variant: variant.name, index, complete: false, errors: [], unexpected: [], api: [] };
    (index < 0 ? discarded : raw).push(row);
    let ledger: ReturnType<typeof routeLedger> | undefined, sampleFailure: unknown;
    try {
      const page: Page = await deadline(context.newPage(), 'Replay page'); page.setDefaultTimeout(30_000);
      page.on('pageerror', error => row.errors.push(error.message));
      page.on('response', response => {
        if (new URL(response.url()).origin === variant.fixture.ready.url && new URL(response.url()).pathname.startsWith('/api/')) {
          const headers = response.headers(); let cache: unknown;
          try { cache = JSON.parse(headers['x-performance-cache']); } catch { cache = null; }
          row.api.push({ url: response.url(), status: response.status(), cache, handlerMs: headers['x-performance-handler-ms'] });
        }
      });
      await page.addInitScript('globalThis.__name = function(value) { return value; };');
      await page.addInitScript(({ from, to }) => {
        localStorage.setItem('culture-desk.filters.v3', JSON.stringify({ cities: [], from, to, genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30 }));
        (window as any).__posterShifts = []; (window as any).__posterShiftError = null;
        try {
          const observer = new PerformanceObserver(list => (window as any).__posterShifts.push(...list.getEntries().map((entry: any) => ({ startTime: entry.startTime, value: entry.value, hadRecentInput: entry.hadRecentInput }))));
          observer.observe({ type: 'layout-shift', buffered: true }); (window as any).__posterShiftObserver = observer;
        } catch (error) { (window as any).__posterShiftError = String(error); }
      }, variant.info.snapshot.coverage);
      ledger = routeLedger(page); row.routes = ledger.routes; row.requests = ledger.requests;
      await page.route('**/*', route => {
        const request = route.request(), url = request.url();
        if (new URL(url).origin === variant.fixture.ready.url) return ledger!.track(route, 'local', () => route.continue());
        const saved = images.get(url);
        if (request.resourceType() === 'image' && saved) return ledger!.track(route, 'saved-raster', () => route.fulfill({ contentType: saved.contentType, body: saved.body }), { hash: saved.hash, bytes: saved.body.byteLength });
        if (request.resourceType() === 'image' && variant.allowed.has(url)) return ledger!.track(route, 'unselected-svg', () => route.fulfill({ contentType: 'image/svg+xml', body: placeholder }));
        row.unexpected.push(url); return ledger!.track(route, 'blocked', () => route.abort('blockedbyclient'));
      });
      if (cpuRate !== 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
      await page.goto(variant.fixture.ready.url, { waitUntil: 'domcontentloaded' });
      const domReadyMs = await cardsReady(page), actionStartMs = scroll === 'first-result' ? await page.evaluate(() => performance.now()) : 0;
      if (scroll === 'first-result') await page.locator('.performance-grid .performance-card').first().scrollIntoViewIfNeeded();
      const visual = await deadline(page.evaluate(async ({ expectedImages }) => {
        const visible = () => [...document.querySelectorAll<HTMLImageElement>('.performance-grid .card-art img')].filter(img => {
          const rect = img.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
        });
        const initial = visible(), initialUrls = initial.map(img => img.currentSrc || img.src), missing = initialUrls.filter(url => !expectedImages.some(entry => entry.url === url));
        if (!initial.length || missing.length) throw new Error(`Viewport lacks saved poster coverage: ${JSON.stringify(missing)}`);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const decodeStartedMs = performance.now();
        try {
          await Promise.race([Promise.all(initial.map(img => img.decode())), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Visible poster decode deadline')), 30_000); })]);
        } finally { clearTimeout(timeout); }
        const decodeReadyMs = performance.now();
        await new Promise<void>((resolveStable, reject) => {
          let previous = '', stable = 0, frame = 0;
          const cleanup = () => { clearTimeout(timer); cancelAnimationFrame(frame); };
          const timer = setTimeout(() => { cleanup(); reject(new Error('Poster/card rectangles did not stabilize within 5 seconds')); }, 5_000);
          const tick = () => {
            const current = JSON.stringify(visible().map(img => {
              const rect = img.getBoundingClientRect(), card = img.closest('.performance-card')!.getBoundingClientRect();
              return [img.currentSrc || img.src, rect.x, rect.y, rect.width, rect.height, card.x, card.y, card.width, card.height];
            }));
            stable = current === previous ? stable + 1 : 0; previous = current;
            if (stable >= 2) { cleanup(); resolveStable(); } else frame = requestAnimationFrame(tick);
          };
          frame = requestAnimationFrame(tick);
        });
        const finalImages = visible();
        if (finalImages.length !== initial.length || finalImages.some((img, index) => img !== initial[index] || (img.currentSrc || img.src) !== initialUrls[index] || !img.complete || !img.naturalWidth)) throw new Error('Viewport image set changed or decode failed');
        for (const img of finalImages) {
          const expected = expectedImages.find(entry => entry.url === (img.currentSrc || img.src))!;
          if (img.naturalWidth !== expected.width || img.naturalHeight !== expected.height) throw new Error('Raster dimensions differ from acquisition');
        }
        const visualReadyMs = performance.now(); (window as any).__posterShiftObserver?.disconnect();
        return { decodeStartedMs, decodeReadyMs, visualReadyMs,
          result: { totalText: document.querySelector('.result-total')?.textContent ?? '', total: Number(document.querySelector('.result-total')?.textContent?.replaceAll(',', '')), displayed: document.querySelectorAll('.performance-grid .performance-card').length },
          images: finalImages.map(img => ({ url: img.currentSrc || img.src, width: img.naturalWidth, height: img.naturalHeight })),
          layoutShiftError: (window as any).__posterShiftError,
          layoutShifts: (window as any).__posterShifts.filter((entry: any) => entry.startTime <= visualReadyMs && !entry.hadRecentInput),
          resources: performance.getEntriesByType('resource').map(entry => entry.toJSON()),
          viewport: { clientWidth: document.documentElement.clientWidth, innerWidth, scrollWidth: document.documentElement.scrollWidth },
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      }, { expectedImages: [...images].map(([url, value]) => ({ url, ...value.dimensions })) }), 'Poster visual readiness', 40_000);
      Object.assign(row, { domReadyMs, actionStartMs, actionToVisualReadyMs: visual.visualReadyMs - actionStartMs, postDomWaitMs: visual.visualReadyMs - domReadyMs, ...visual });
      assert.deepEqual(row.errors, []); assert.deepEqual(row.unexpected, []); assert.equal(visual.layoutShiftError, null); assert.ok(visual.overflow <= 1);
      assert.equal(visual.result.total, variant.info.count, 'Rendered total matches the pinned snapshot');
      assert.equal(visual.result.displayed, Math.min(30, variant.info.count), 'Expected first page of cards');
      if (device === 'desktop' && scroll === 'none') assert.deepEqual(visual.images.map(image => image.url).sort(), [...images.keys()].sort(), 'Initial desktop viewport displays the complete acquired poster set');
      for (const image of visual.images) assert.ok(row.routes.some((route: any) => route.url === image.url && route.operation === 'saved-raster' && route.state === 'settled' && route.hash === images.get(image.url)!.hash), 'Visible raster actually fulfilled with saved bytes');
      for (const pathname of ['/api/bootstrap', '/api/performances']) assert.ok(row.api.some((response: any) => new URL(response.url).pathname === pathname && response.status === 200 && response.cache?.reads > 0), `Observed ${pathname} producer`);
      assert.ok(row.api.every((response: any) => response.status === 200 && response.cache && response.cache.reads === response.cache.produces && response.cache.joined === 0), 'Every observed cached API read is a true producer miss');
      if (index === 0) await page.screenshot({ path: resolve(dirname(args.out), `${basename(args.out, '.json')}-${variant.name}.png`) });
      row.measurementComplete = true;
    } catch (error) { sampleFailure = error; row.error = String(error); }
    finally {
      report.phase = 'sample-cleanup';
      const beforeCleanupSaveError = await saveWithoutSkippingCleanup(); sampleFailure ??= beforeCleanupSaveError;
      ledger?.beginClose(); let closed = false;
      try { await deadline(context.close(), 'Replay context close', 5_000); closed = true; row.contextClosed = true; }
      catch (error) { row.cleanupError = String(error); sampleFailure ??= error; }
      try {
        row.settlement = await ledger?.settle(closed);
        if (row.settlement) { assert.equal(row.settlement.pendingRoutes, 0); assert.equal(row.settlement.pendingRequests, 0); assert.deepEqual(row.settlement.errors, []); }
      } catch (error) { row.settlementError = String(error); sampleFailure ??= error; }
      row.complete = !sampleFailure; report.phase = 'measuring';
      const afterCleanupSaveError = await saveWithoutSkippingCleanup(); sampleFailure ??= afterCleanupSaveError;
      if (sampleFailure) row.complete = false;
    }
    if (sampleFailure) throw sampleFailure;
    console.log(JSON.stringify({ variant: variant.name, index, domReadyMs: row.domReadyMs, visualReadyMs: row.visualReadyMs, images: row.images.length }));
  }
} catch (error) { failure = error; report.error = String(error); }
finally {
  // Save the full raw result before cleanup; hung or failed cleanup cannot erase it.
  report.phase = 'cleanup'; await saveWithoutSkippingCleanup();
  if (managed) try { report.cleanup.push(...await managed.close()); }
  catch (error) { report.cleanup.push({ action: 'browser.cleanup', success: false, error: String(error) }); }
  for (const variant of variants) {
    try { await deadline(variant.fixture.stop(), `${variant.name} fixture stop`, 8_000); report.cleanup.push({ action: `${variant.name}.fixture.stop`, success: true }); }
    catch (error) { report.cleanup.push({ action: `${variant.name}.fixture.stop`, success: false, error: String(error) }); }
  }
  for (const variant of variants) {
    const source = report.sources.find((entry: any) => entry.variant === variant.name);
    try {
      source.sourceAfter = await sourceFingerprint(variant.root); source.buildAfter = await clientFingerprint(variant.root);
      source.sourceStable = source.sourceBefore.hash === source.sourceAfter.hash; source.buildStable = source.buildBefore.hash === source.buildAfter.hash;
    } catch (error) { source.sourceStable = false; source.buildStable = false; source.error = String(error); failure ??= error; }
  }
  const summarize = (rows: any[]) => ({ completedSamples: rows.length, ...(rows.length ? { domReady: statistics(rows.map(row => row.domReadyMs)), visualReady: statistics(rows.map(row => row.visualReadyMs)),
      actionToVisualReady: statistics(rows.map(row => row.actionToVisualReadyMs)), postDomWait: statistics(rows.map(row => row.postDomWaitMs)) } : {}) });
  report.summary = variants.map(variant => {
    const rows = raw.filter(row => row.variant === variant.name && row.complete);
    return { variant: variant.name, ...summarize(rows) };
  });
  report.timeBlocks = Array.from({ length: Math.min(3, samples) }, (_, index) => {
    const start = Math.floor(index * samples / Math.min(3, samples)), end = Math.floor((index + 1) * samples / Math.min(3, samples));
    return { index, firstPair: start, lastPair: end - 1, variants: variants.map(variant => ({ variant: variant.name,
      ...summarize(raw.filter(row => row.variant === variant.name && row.complete && row.index >= start && row.index < end)) })) };
  });
  report.quantileNote = 'Nearest-rank quantiles; 20 samples provide a descriptive p95, not a broad tail-performance guarantee. Three contiguous pair-index blocks diagnose drift; their smaller p95 values are not independent tail claims.';
  report.complete = !failure && report.sources.length === 2 && report.sources.every((source: any) => source.sourceStable && source.buildStable) && report.cleanup.every((action: any) => action.success);
  report.phase = 'finished'; report.finishedAt = new Date().toISOString(); await saveWithoutSkippingCleanup();
}
if (failure) throw failure;
assert.equal(report.complete, true, 'Replay, pinned provenance and cleanup must pass');
console.log(JSON.stringify({ out: args.out, summary: report.summary }, null, 2));
