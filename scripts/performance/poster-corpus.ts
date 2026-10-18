import assert from 'node:assert/strict';
import { devices, type BrowserContext } from '@playwright/test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argumentsOf, clientFingerprint, saveJson, sha256, snapshotInfo, sourceFingerprint, workspace } from './common.js';
import { startBrowserFixture } from './browser-fixture.js';
import { deadline, launchPosterBrowser, rasterMetadata, routeLedger } from './poster-runtime.js';

// Explicit one-pass acquisition. Do not run during a controlled benchmark window.
const args = argumentsOf(), root = resolve(args.root ?? workspace);
if (!args.out) throw new Error('--out is required');
const output = resolve(args.out), directory = dirname(output);
if (!directory.startsWith(resolve(workspace, 'data') + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Poster bytes must stay in ignored workspace data/');
try { await access(output); throw new Error('Poster manifest already exists; acquisition is one-pass'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const device = args.device ?? 'desktop';
if (!['desktop', 'mobile'].includes(device)) throw new Error('Invalid device');
const info = await snapshotInfo(root), buildBefore = await clientFingerprint(root), sourceBefore = await sourceFingerprint(root);
const viewport = device === 'mobile' ? { width: 375, height: 812 } : { width: 1440, height: 1000 };
const allowed = new Set<string>(info.snapshot.performances.flatMap((row: any) => {
  try { const url = new URL(row.poster); return ['http:', 'https:'].includes(url.protocol) ? [url.href] : []; }
  catch { return []; }
}));
const report: any = { version: 2, complete: false, phase: 'starting', startedAt: new Date().toISOString(), root, device, viewport,
  snapshot: { path: info.path, hash: info.hash, bytes: info.bytes, rows: info.count }, filters: info.snapshot.coverage,
  sourceBefore, buildBefore, selected: [], entries: [], cleanup: [], persistenceErrors: [],
  scope: 'At most eight unique public-snapshot poster URLs intersecting the initial cards viewport. Selection uses local SVG placeholders; each selected URL is fetched once, with a 5 MiB body and 30 second HTTP limit. Accepted corpus bytes must have a matching PNG/JPEG/GIF/WebP/AVIF signature and MIME and decode to nonzero dimensions; SVG is rejected. No crawl, retry or arbitrary image collection. Replay uses exact saved bytes.' };
// Reserve before HTTP; every partial preserves the complete provenance.
await mkdir(directory, { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
let fixture: Awaited<ReturnType<typeof startBrowserFixture>> | undefined;
let managed: Awaited<ReturnType<typeof launchPosterBrowser>> | undefined;
let selectionContext: BrowserContext | undefined, ledger: ReturnType<typeof routeLedger> | undefined;
let failure: unknown;
async function saveWithoutSkippingCleanup() {
  try { await saveJson(output, report); }
  catch (error) {
    const evidence = { phase: report.phase, error: String(error), at: new Date().toISOString() };
    report.persistenceErrors.push(evidence); report.complete = false; failure ??= error;
    console.error(JSON.stringify({ type: 'poster-report-save-failed', ...evidence }));
  }
}
try {
  fixture = await startBrowserFixture(root, 'miss');
  managed = await launchPosterBrowser(); report.browserVersion = managed.browser.version(); report.ownedBrowserPid = managed.pid;
  selectionContext = await deadline(managed.browser.newContext({ ...(device === 'mobile' ? devices['Pixel 7'] : devices['Desktop Chrome']),
    viewport, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' }), 'Selection context');
  const page = await deadline(selectionContext.newPage(), 'Selection page'); page.setDefaultTimeout(30_000);
  const errors: string[] = [], unexpected: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript('globalThis.__name = function(value) { return value; };');
  await page.addInitScript(({ from, to }) => localStorage.setItem('culture-desk.filters.v3', JSON.stringify({ cities: [], from, to, genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30 })), info.snapshot.coverage);
  ledger = routeLedger(page); report.selectionRoutes = ledger.routes; report.selectionRequests = ledger.requests;
  const placeholder = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#8b9ba5"/></svg>';
  await page.route('**/*', route => {
    const request = route.request(), url = request.url();
    if (new URL(url).origin === fixture!.ready.url) return ledger!.track(route, 'local', () => route.continue());
    if (request.resourceType() === 'image' && allowed.has(url)) return ledger!.track(route, 'selection-svg', () => route.fulfill({ contentType: 'image/svg+xml', body: placeholder }));
    unexpected.push(url); return ledger!.track(route, 'blocked', () => route.abort('blockedbyclient'));
  });
  await page.goto(fixture.ready.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.results')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.performance-card').length > 0);
  let selected = await page.locator('.performance-grid .card-art img').evaluateAll(images => images.flatMap(image => {
    const img = image as HTMLImageElement, rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return [];
    return [{ url: img.currentSrc || img.src, title: img.closest('.performance-card')?.querySelector('h3')?.textContent,
      rectangle: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }];
  }));
  selected = selected.filter((item, index, items) => items.findIndex(other => other.url === item.url) === index).slice(0, 8);
  report.selected = selected; report.selectionErrors = errors; report.selectionUnexpected = unexpected; report.phase = 'selected';
  await saveJson(output, report);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  if (!selected.length || selected.some(item => !allowed.has(item.url))) throw new Error('No eligible visible public-snapshot posters');
  ledger.beginClose(); await deadline(selectionContext.close(), 'Selection context close', 5_000); selectionContext = undefined;
  report.selectionSettlement = await ledger.settle(true);
  assert.equal(report.selectionSettlement.pendingRoutes, 0); assert.equal(report.selectionSettlement.pendingRequests, 0);
  assert.deepEqual(report.selectionSettlement.errors, []);
  const decoder = await deadline(managed.browser.newPage(), 'Decoder page');
  await decoder.evaluate('globalThis.__name = function(value) { return value; };');
  for (const item of selected) {
    const entry: any = { ...item, acquiredAt: new Date().toISOString(), success: false };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
    let response: Response | undefined;
    try {
      response = await fetch(item.url, { signal: controller.signal, redirect: 'follow' });
      entry.status = response.status; entry.finalUrl = response.url; entry.contentType = response.headers.get('content-type') ?? '';
      if (!response.ok) throw new Error('HTTP response was not successful');
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > 5 * 1024 * 1024) throw new Error('Declared poster exceeds 5 MiB');
      const reader = response.body?.getReader(); if (!reader) throw new Error('Missing image body');
      const chunks: Uint8Array[] = []; let bytes = 0, ended = false;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) { ended = true; break; }
          bytes += chunk.value.byteLength;
          entry.receivedBytes = bytes;
          if (bytes > 5 * 1024 * 1024) throw new Error('Poster exceeds 5 MiB');
          chunks.push(chunk.value);
        }
      } finally {
        try {
          if (!ended) { controller.abort(); await deadline(reader.cancel().catch(error => { entry.bodyCancellationError = String(error); }), 'Poster reader cancel', 5_000); }
        } finally { reader.releaseLock(); }
      }
      clearTimeout(timer);
      const body = Buffer.concat(chunks), hash = sha256(body);
      entry.bytes = body.byteLength; entry.hash = hash; entry.raster = rasterMetadata(body, entry.contentType);
      entry.file = `${report.entries.length + 1}-${hash.slice(0, 16)}.${entry.raster.format}`;
      await writeFile(resolve(directory, entry.file), body, { flag: 'wx' });
      entry.dimensions = await deadline(decoder.evaluate(async ({ encoded, type }) => {
        const img = new Image(); img.src = `data:${type};base64,${encoded}`;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([img.decode(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Local poster decode exceeded 30 seconds')), 30_000); })]);
          return { width: img.naturalWidth, height: img.naturalHeight };
        } finally { clearTimeout(timeout); img.src = ''; }
      }, { encoded: body.toString('base64'), type: entry.raster.mime }), 'Local poster decode', 35_000);
      entry.success = entry.dimensions.width > 0 && entry.dimensions.height > 0;
      if (!entry.success) throw new Error('Decoded image has no dimensions');
    } catch (error) {
      controller.abort(); entry.error = String(error);
      if (response?.body && !response.body.locked) try { await deadline(response.body.cancel(), 'Rejected response body cancel', 5_000); }
      catch (cancelError) { entry.bodyCancellationError = String(cancelError); }
    } finally { clearTimeout(timer); }
    report.entries.push(entry); report.phase = 'acquiring';
    await saveJson(output, report);
    console.log(JSON.stringify({ url: entry.url, status: entry.status, bytes: entry.bytes, success: entry.success, error: entry.error }));
  }
  report.acquisitionComplete = true;
} catch (error) { failure = error; report.error = String(error); }
finally {
  report.phase = 'cleanup'; await saveWithoutSkippingCleanup();
  if (selectionContext) {
    ledger?.beginClose(); let closed = false;
    try { await deadline(selectionContext.close(), 'Selection cleanup', 5_000); closed = true; }
    catch (error) { report.cleanup.push({ action: 'selection.close', success: false, error: String(error) }); }
    try { report.selectionSettlement = await ledger?.settle(closed); }
    catch (error) { report.cleanup.push({ action: 'selection.routes', success: false, error: String(error) }); }
  }
  if (managed) try { report.cleanup.push(...await managed.close()); }
  catch (error) { report.cleanup.push({ action: 'browser.cleanup', success: false, error: String(error) }); }
  if (fixture) try { await deadline(fixture.stop(), 'Fixture stop', 8_000); report.cleanup.push({ action: 'fixture.stop', success: true }); }
  catch (error) { report.cleanup.push({ action: 'fixture.stop', success: false, error: String(error) }); }
  try {
    report.sourceAfter = await sourceFingerprint(root); report.buildAfter = await clientFingerprint(root);
    report.sourceStable = sourceBefore.hash === report.sourceAfter.hash; report.buildStable = buildBefore.hash === report.buildAfter.hash;
  } catch (error) { report.sourceStable = false; report.buildStable = false; report.error = String(error); failure ??= error; }
  report.complete = !failure && report.sourceStable && report.buildStable && report.cleanup.every((action: any) => action.success);
  report.phase = 'finished'; report.finishedAt = new Date().toISOString(); await saveWithoutSkippingCleanup();
}
if (failure) throw failure;
assert.equal(report.complete, true, 'Acquisition provenance and cleanup must pass');
console.log(JSON.stringify({ out: output, selected: report.selected.length, successful: report.entries.filter((entry: any) => entry.success).length }));
