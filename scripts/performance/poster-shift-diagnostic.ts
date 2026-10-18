import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { argumentsOf, clientFingerprint, saveJson, sha256, snapshotInfo, sourceFingerprint } from './common.js';
import { startBrowserFixture } from './browser-fixture.js';
import { deadline, launchPosterBrowser, rasterMetadata, routeLedger } from './poster-runtime.js';

// Attribution only: two fresh contexts, one per preserved build. Observer work
// changes scheduling, so none of these timings are performance acceptance data.
const args = argumentsOf();
assert.ok(args.root && args['compare-root'] && args.manifest && args.out);
const output = resolve(args.out), manifestPath = resolve(args.manifest);
for (const path of [output, ...['baseline', 'candidate'].map(name => resolve(dirname(output), `${basename(output, '.json')}-${name}.png`))]) {
  await access(path).then(() => { throw new Error(`Refusing to replace ${path}`); }, error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}
const harnessBefore = sha256(await readFile(new URL(import.meta.url)));
const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes.toString('utf8'));
assert.equal(manifest.version, 2); assert.equal(manifest.complete, true);
assert.equal(manifest.sourceStable, true); assert.equal(manifest.buildStable, true);
const images = new Map<string, { body: Buffer; mime: string; hash: string; width: number; height: number }>();
for (const entry of manifest.entries.filter((entry: any) => entry.success)) {
  const path = resolve(dirname(manifestPath), entry.file);
  assert.equal(dirname(path), dirname(manifestPath));
  const body = await readFile(path), raster = rasterMetadata(body, entry.contentType);
  assert.equal(sha256(body), entry.hash); assert.equal(body.length, entry.bytes); assert.deepEqual(raster, entry.raster);
  images.set(entry.url, { body, mime: raster.mime, hash: entry.hash, ...entry.dimensions });
}
assert.equal(images.size, 4, 'This diagnostic uses the four acquired desktop posters');
const report: any = { version: 1, startedAt: new Date().toISOString(), complete: false,
  scope: 'One diagnostic baseline/candidate pair, no warmup or timing acceptance. Saved GIF bytes for four initially visible posters; other known posters use fixed SVG substitutes. Node identities, layout-shift sources and bounded frame geometry distinguish retained-element movement from newly inserted content. First observation is not proof of insertion. No external HTTP, application instrumentation, CSS changes, or forced GC.',
  manifest: { path: manifestPath, hash: sha256(manifestBytes), images: [...images].map(([url, image]) => ({ url, hash: image.hash, bytes: image.body.length, width: image.width, height: image.height })) },
  harness: { beforeHash: harnessBefore }, rows: [], cleanup: [], persistenceErrors: [] };
const variants: any[] = [];
let managed: Awaited<ReturnType<typeof launchPosterBrowser>> | undefined, failure: unknown;
async function persist() {
  try { await saveJson(output, report); }
  catch (error) { failure ??= error; report.complete = false; report.persistenceErrors.push(String(error)); }
}

try {
  for (const [name, rootPath] of [['baseline', args.root], ['candidate', args['compare-root']]]) {
    const root = resolve(rootPath), info = await snapshotInfo(root);
    assert.equal(info.hash, manifest.snapshot.hash);
    const source = await sourceFingerprint(root), build = await clientFingerprint(root);
    const fixture = await startBrowserFixture(root, 'miss');
    const row: any = { variant: name, root, sourceBefore: source, buildBefore: build,
      snapshot: { hash: info.hash, rows: info.count }, errors: [], unexpected: [], api: [], complete: false };
    variants.push({ root, info, fixture, row }); report.rows.push(row);
  }
  managed = await launchPosterBrowser(); report.browserVersion = managed.browser.version();
  for (const { info, fixture, row } of variants) {
    const context = await deadline(managed.browser.newContext({ viewport: { width: 1440, height: 1000 },
      locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' }), 'Diagnostic context');
    let ledger: ReturnType<typeof routeLedger> | undefined;
    try {
      const page = await deadline(context.newPage(), 'Diagnostic page'); page.setDefaultTimeout(15_000);
      page.on('pageerror', error => row.errors.push(error.message));
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin === fixture.ready.url && url.pathname.startsWith('/api/')) {
          let cache: unknown; try { cache = JSON.parse(response.headers()['x-performance-cache']); } catch { cache = null; }
          row.api.push({ path: url.pathname, status: response.status(), cache });
        }
      });
      await page.addInitScript('globalThis.__name = function(value) { return value; };');
      await page.addInitScript(({ from, to }) => {
        localStorage.setItem('culture-desk.filters.v3', JSON.stringify({ cities: [], from, to, genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30 }));
        const trace: any = { timeOrigin: performance.timeOrigin, shifts: [], mutations: [], frames: [], observerErrors: [], truncated: {}, stopped: false };
        (window as any).__shiftDiagnostic = trace;
        const ids = new WeakMap<Node, { id: number; firstObservedAt: number }>(); let nextId = 1, frame = 0, previous = '';
        const describe = (node: Node | null) => {
          if (!node) return null;
          let identity = ids.get(node); if (!identity) { identity = { id: nextId++, firstObservedAt: performance.now() }; ids.set(node, identity); }
          const element = node instanceof Element ? node : node.parentElement;
          const parts: string[] = []; let current: Element | null = element;
          for (let depth = 0; current && depth < 5; depth++, current = current.parentElement) {
            const index = current.parentElement ? [...current.parentElement.children].filter(sibling => sibling.tagName === current!.tagName).indexOf(current) + 1 : 1;
            parts.unshift(`${current.tagName.toLowerCase()}${current.id ? `#${CSS.escape(current.id)}` : ''}${[...current.classList].slice(0, 3).map(name => `.${CSS.escape(name)}`).join('')}:nth-of-type(${index})`);
            if (current.id) break;
          }
          return { ...identity, selector: parts.join(' > '), connected: node.isConnected,
            text: element?.textContent?.trim().slice(0, 100) ?? '', nodeType: node.nodeType };
        };
        const rect = (value: DOMRectReadOnly) => ({ x: value.x, y: value.y, width: value.width, height: value.height });
        const append = (key: 'shifts' | 'mutations' | 'frames', value: any, cap: number) => {
          if (trace[key].length < cap) trace[key].push(value); else trace.truncated[key] = (trace.truncated[key] ?? 0) + 1;
        };
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries() as any[]) append('shifts', { startTime: entry.startTime, value: entry.value,
            hadRecentInput: entry.hadRecentInput, lastInputTime: entry.lastInputTime,
            sources: (entry.sources ?? []).map((source: any) => ({ node: describe(source.node), previousRect: rect(source.previousRect), currentRect: rect(source.currentRect) })) }, 80);
        });
        try { observer.observe({ type: 'layout-shift', buffered: true }); } catch (error) { trace.observerErrors.push(String(error)); }
        const mutations = new MutationObserver(records => {
          append('mutations', { at: performance.now(), records: records.slice(0, 12).map(record => ({ type: record.type,
            target: describe(record.target), attribute: record.attributeName, oldValue: record.oldValue,
            addedCount: record.addedNodes.length, removedCount: record.removedNodes.length,
            added: [...record.addedNodes].slice(0, 6).map(describe), removed: [...record.removedNodes].slice(0, 6).map(describe) })), omittedRecords: Math.max(0, records.length - 12) }, 100);
        });
        mutations.observe(document, { childList: true, subtree: true, attributes: true, attributeOldValue: true,
          attributeFilter: ['class', 'aria-busy', 'hidden'], characterData: true });
        const selectors = ['body', '#root', '.standalone', '.shell', '.sidebar', '.main', '.explore-head', '.search-toolbar', '.results', '.results-head', '.results-actions', '.result-counts', '.loading-inline', '.performance-grid', '.performance-card:first-child', '.card-art', '.results-foot', '.explore-sources'];
        const tick = () => {
          const nodes = selectors.flatMap(selector => {
            const element = document.querySelector<HTMLElement>(selector); if (!element) return [];
            return [{ selector, node: describe(element), rect: rect(element.getBoundingClientRect()), busy: element.getAttribute('aria-busy') }];
          });
          const signature = JSON.stringify(nodes.map(node => [node.node?.id, node.rect, node.busy]));
          if (signature !== previous) { previous = signature; append('frames', { at: performance.now(), scrollX, scrollY,
            viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, innerWidth, innerHeight }, nodes }, 120); }
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        setTimeout(() => { observer.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame); trace.stopped = true; trace.stoppedAt = performance.now(); }, 3_000);
      }, info.snapshot.coverage);
      ledger = routeLedger(page); row.routes = ledger.routes; row.requests = ledger.requests;
      const allowed = new Set<string>(info.snapshot.performances.flatMap((item: any) => { try { return [new URL(item.poster).href]; } catch { return []; } }));
      await page.route('**/*', route => {
        const request = route.request(), url = request.url();
        if (new URL(url).origin === fixture.ready.url) return ledger!.track(route, 'local', () => route.continue());
        const image = images.get(url);
        if (request.resourceType() === 'image' && image) return ledger!.track(route, 'saved-raster', () => route.fulfill({ contentType: image.mime, body: image.body }), { hash: image.hash, bytes: image.body.length });
        if (request.resourceType() === 'image' && allowed.has(url)) return ledger!.track(route, 'unselected-svg', () => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#8b9ba5"/></svg>' }));
        row.unexpected.push(url); return ledger!.track(route, 'blocked', () => route.abort('blockedbyclient'));
      });
      await page.goto(fixture.ready.url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('.results')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.performance-card').length === 30);
      await deadline(page.evaluate(async () => {
        const images = [...document.querySelectorAll<HTMLImageElement>('.performance-grid .card-art img')].filter(image => { const r = image.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 && r.width > 0; });
        await Promise.all(images.map(image => image.decode()));
      }), 'Diagnostic visible image decode', 30_000);
      await page.waitForFunction(() => (window as any).__shiftDiagnostic?.stopped === true);
      row.diagnostic = await page.evaluate(() => ({ ...(window as any).__shiftDiagnostic,
        total: Number(document.querySelector('.result-total')?.textContent?.replaceAll(',', '')),
        images: [...document.querySelectorAll<HTMLImageElement>('.performance-grid .card-art img')].filter(image => { const r = image.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 && r.width > 0; }).map(image => ({ url: image.currentSrc || image.src, width: image.naturalWidth, height: image.naturalHeight, complete: image.complete })),
        resources: performance.getEntriesByType('resource').map(entry => entry.toJSON()) }));
      assert.equal(row.diagnostic.total, info.count); assert.deepEqual(row.diagnostic.observerErrors, []);
      assert.deepEqual(row.diagnostic.images.map((image: any) => image.url).sort(), [...images.keys()].sort());
      for (const image of row.diagnostic.images) { const expected = images.get(image.url)!; assert.ok(image.complete); assert.equal(image.width, expected.width); assert.equal(image.height, expected.height); }
      assert.deepEqual(row.errors, []); assert.deepEqual(row.unexpected, []);
      assert.equal(row.api.length, 2); assert.ok(row.api.every((entry: any) => entry.status === 200 && entry.cache?.reads === entry.cache?.produces && entry.cache?.joined === 0));
      await page.screenshot({ path: resolve(dirname(output), `${basename(output, '.json')}-${row.variant}.png`) });
      row.complete = true;
    } finally {
      await persist(); ledger?.beginClose(); let closed = false;
      try { await deadline(context.close(), 'Diagnostic context close', 5_000); closed = true; }
      finally { row.settlement = await ledger?.settle(closed); }
      assert.equal(row.settlement?.pendingRoutes, 0); assert.equal(row.settlement?.pendingRequests, 0); assert.deepEqual(row.settlement?.errors, []);
    }
    if (failure) throw failure;
  }
} catch (error) { failure = error; report.error = String(error); }
finally {
  await persist();
  if (managed) try { report.cleanup.push(...await managed.close()); } catch (error) { failure ??= error; report.cleanup.push({ action: 'browser cleanup', success: false, error: String(error) }); }
  for (const { fixture, row } of variants) try { await deadline(fixture.stop(), 'Diagnostic fixture stop', 8_000); report.cleanup.push({ action: `${row.variant} fixture stop`, success: true }); }
  catch (error) { failure ??= error; report.cleanup.push({ action: `${row.variant} fixture stop`, success: false, error: String(error) }); }
  for (const { root, row } of variants) try {
    row.sourceAfter = await sourceFingerprint(root); row.buildAfter = await clientFingerprint(root);
    row.sourceStable = row.sourceBefore.hash === row.sourceAfter.hash; row.buildStable = row.buildBefore.hash === row.buildAfter.hash;
    assert.ok(row.sourceStable && row.buildStable);
  } catch (error) { failure ??= error; row.provenanceError = String(error); }
  try { report.harness.afterHash = sha256(await readFile(new URL(import.meta.url))); assert.equal(report.harness.afterHash, harnessBefore); }
  catch (error) { failure ??= error; report.harness.error = String(error); }
  report.complete = !failure && report.rows.length === 2 && report.rows.every((row: any) => row.complete) && report.cleanup.every((action: any) => action.success);
  report.finishedAt = new Date().toISOString(); await persist();
}
if (failure) throw failure;
assert.ok(report.complete);
console.log(JSON.stringify({ out: output, complete: report.complete, rows: report.rows.map((row: any) => ({ variant: row.variant, shifts: row.diagnostic.shifts.length })) }));
