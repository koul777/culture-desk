import assert from 'node:assert/strict';
import { chromium, devices, type BrowserContext, type Page, type Request, type Route } from '@playwright/test';
import { basename, dirname, resolve } from 'node:path';
import { argumentsOf, clientFingerprint, saveJson, snapshotInfo, sourceFingerprint, workspace } from './common.js';
import { startBrowserFixture } from './browser-fixture.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
if (!args.out) throw new Error('--out is required');
const samples = Number(args.samples ?? '1');
assert.ok(Number.isSafeInteger(samples) && samples > 0 && samples <= 10);
const defaultScenarios = ['osm', 'vworld-protocol', 'close-config', 'close-building', 'close-chunk'] as const;
const allowedScenarios = [...defaultScenarios, 'background-retry', 'rapid-reopen', 'chunk-failure'] as const;
type Scenario = typeof allowedScenarios[number];
const scenarioArguments = (args.scenarios ?? defaultScenarios.join(',')).split(',').map(value => value.trim());
assert.ok(scenarioArguments.every(value => allowedScenarios.includes(value as Scenario)), `--scenarios must contain only: ${allowedScenarios.join(',')}`);
assert.equal(new Set(scenarioArguments).size, scenarioArguments.length, '--scenarios must not contain duplicates');
const scenarios = scenarioArguments as Scenario[];
const expectedBuildingOrder = args['building-order'] ?? 'serial';
assert.ok(expectedBuildingOrder === 'serial' || expectedBuildingOrder === 'parallel', '--building-order must be serial or parallel');
assert.ok(args.dev === undefined || args.dev === 'true', '--dev accepts true only');
const development = args.dev === 'true';
const CASE_TIMEOUT_MS = 90_000, OVERALL_TIMEOUT_MS = 300_000;
const overallDeadline = Date.now() + OVERALL_TIMEOUT_MS;
class ProbeTimeout extends Error {}
async function bounded<T>(label: string, operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeTimeout(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
type CaseScope = { dispose?: () => Promise<void> };
const info = await snapshotInfo(root);
const before = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
const workspaceClientBefore = development ? await clientFingerprint(workspace) : undefined;
const venue = info.snapshot.performances.find((item: any) => item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
  && item.latitude > 33 && item.latitude < 39 && item.longitude > 124 && item.longitude < 132);
assert.ok(venue);
const lon = venue.longitude, lat = venue.latitude;
// Deliberately synthetic geometry at a real snapshot coordinate. This tests sequence and
// cleanup, not building accuracy or external provider latency.
const building = { status: 'available', performanceId: venue.id, source: 'LOCAL_SEQUENCE_FIXTURE', attribution: 'Synthetic fixture geometry',
  building: { type: 'Polygon', coordinates: [[[lon - .00015, lat - .0001], [lon + .00015, lat - .0001], [lon + .00015, lat + .0001], [lon - .00015, lat + .0001], [lon - .00015, lat - .0001]]],
    name: 'Synthetic sequence fixture', sourceUrl: '', osmType: 'way', osmId: 0, confidence: 'coordinate', matchMethod: 'local-fixture', distanceMeters: 0,
    heightMeters: 12, heightSource: 'tag', estimatedHeight: false }, message: 'Synthetic fixture geometry', checkedAt: '2026-10-18T00:00:00Z' };
const fixture = await startBrowserFixture(root).catch(async error => {
  await saveJson(args.out, { status: 'failed', phase: 'fixture-start', error: String(error), before, rows: [] });
  throw error;
});
const developmentServer = development ? await (async () => {
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  // A separate development server exercises real React StrictMode effects. Do not
  // load the workspace build plugin: its closeBundle hook would mutate dist/client.
  const server = await createServer({ configFile: false, root: resolve(root, 'web'), plugins: [react()],
    cacheDir: resolve(workspace, 'data/performance-session-20261019/3d-dev-cache'),
    define: { CESIUM_BASE_URL: JSON.stringify('/cesium/') },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: { ignored: ['**/*'] },
      fs: { allow: [root, workspace] }, proxy: { '^/api(?:/|$)': fixture.ready.url, '^/cesium/': fixture.ready.url } } });
  try { await server.listen(); return server; }
  catch (error) { await server.close(); throw error; }
})().catch(async error => {
  try { await fixture.stop(); }
  finally { await saveJson(args.out, { status: 'failed', phase: 'development-server-start', error: String(error), before, rows: [] }); }
  throw error;
}) : undefined;
const appUrl = developmentServer?.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? fixture.ready.url;
const browser = await chromium.launch().catch(async error => {
  const cleanupErrors: string[] = [];
  try { await developmentServer?.close(); }
  catch (cleanupError) { cleanupErrors.push(String(cleanupError)); }
  finally {
    try { await fixture.stop(); }
    catch (cleanupError) { cleanupErrors.push(String(cleanupError)); }
    finally { await saveJson(args.out, { status: 'failed', phase: 'browser-launch', error: String(error), cleanupErrors, before, rows: [] }); }
  }
  throw error;
});
const rows: any[] = [];
const cleanupErrors: string[] = [];
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dce4e8"/></svg>';
// Cesium requests OSM imagery through fetch/createImageBitmap, not resourceType=image.
// A known one-pixel raster keeps that path local without asserting real tile fidelity.
const tilePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const json = (route: Route, value: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
const isOsmRenderer = (url: string) => /\/assets\/Venue3DDialog-[^/]+\.js$/.test(new URL(url).pathname) || new URL(url).pathname.endsWith('/components/Venue3DDialog.tsx');

async function setup(scenario: Scenario, result: any, scope: CaseScope) {
  let context: BrowserContext | undefined, page: Page | undefined, disposed = false;
  let buildingRequests = 0, blockTiles = scenario === 'background-retry';
  const errors: string[] = result.errors, external: string[] = result.unexpectedExternal, failed: any[] = result.failedRequests, workers: any[] = result.workers;
  const cancelledRequests = new WeakSet<Request>();
  let releaseGate!: () => void;
  const gate = new Promise<void>(done => { releaseGate = done; });
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    releaseGate();
    // A cancelled routed request may never complete Playwright's handledPromise.
    // Detach handlers without waiting for that promise, then close the context.
    try { if (page) await bounded('unroute', page.unrouteAll({ behavior: 'ignoreErrors' }), 2_000); }
    catch (error) { result.cleanupErrors.push({ phase: 'unroute', error: String(error) }); }
    finally {
      try { if (context) await bounded('context-close', context.close(), 5_000); }
      catch (error) { result.cleanupErrors.push({ phase: 'context-close', error: String(error) }); }
    }
  };
  scope.dispose = dispose;
  try {
    result.phase = 'setup-context';
    context = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'ko-KR', serviceWorkers: 'block' });
    if (disposed) { await bounded('late-context-close', context.close(), 5_000); throw new Error('Context opened after scenario disposal'); }
    result.phase = 'setup-page';
    page = await context.newPage();
    if (disposed) { await bounded('late-page-context-close', context.close(), 5_000); throw new Error('Page opened after scenario disposal'); }
    // The captured page remains valid for callback type narrowing; disposed controls its lifetime.
    const routedPage = page;
    page.setDefaultTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => { cancelledRequests.add(request); failed.push({ url: request.url(), error: request.failure()?.errorText }); });
    page.on('worker', worker => { const record = { url: worker.url(), closed: false }; workers.push(record); worker.on('close', () => { record.closed = true; }); });
    result.phase = 'setup-instrumentation';
    await page.addInitScript('globalThis.__name = function(value) { return value; };');
    await page.addInitScript(({ q, from, to }) => {
      localStorage.setItem('culture-desk.filters.v3', JSON.stringify({ cities: [], from, to, genre: '', q, status: '', price: '', age: '', source: '', limit: 30 }));
      performance.setResourceTimingBufferSize(5000);
      const state = (window as any).__threeDProbe = { fetches: [] as any[], dom: [] as any[], longTasks: [] as any[], actionRequests: [] as number[], clicks: [] as number[], rafFired: 0, rafPending: new Set<number>(), resourceOverflow: 0 };
      document.addEventListener('click', event => {
        if (event.target instanceof Element && event.target.closest('.map-popup-3d')) state.clicks.push(performance.now());
      }, true);
      performance.addEventListener('resourcetimingbufferfull', () => { state.resourceOverflow++; });
      const nativeRaf = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => {
        const id = nativeRaf(time => { state.rafPending.delete(id); state.rafFired++; callback(time); });
        state.rafPending.add(id); return id;
      };
      window.cancelAnimationFrame = id => { state.rafPending.delete(id); nativeCancel(id); };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!/\/api\/(maps\/vworld|venues\/building)/.test(url)) return nativeFetch(input, init);
        const id = state.fetches.length;
        const record = (phase: string, error?: string) => state.fetches.push({ id, phase, url, time: performance.now(), error });
        record('start');
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const aborted = () => record('abort');
        signal?.addEventListener('abort', aborted, { once: true });
        return nativeFetch(input, init).then(response => { record('headers'); return response; }, error => { record('error', error.name); throw error; })
          .finally(() => signal?.removeEventListener('abort', aborted));
      };
      try { new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true }); } catch {}
      let previous = '';
      new MutationObserver(() => {
        const osm = document.querySelector('[data-testid="venue-3d"]');
        const vworld = document.querySelector('.vworld-viewer');
        const next = osm ? `osm:${osm.getAttribute('data-ready')}:${osm.getAttribute('data-background-state')}` : vworld ? `vworld:${vworld.getAttribute('data-status')}` : '';
        if (next !== previous) { state.dom.push({ time: performance.now(), state: next, canvases: document.querySelectorAll('dialog[open] canvas').length }); previous = next; }
      }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ready', 'data-background-state', 'data-status'] });
    }, { q: venue.title, from: info.snapshot.coverage.from, to: info.snapshot.coverage.to });
    const routeInactive = (route: Route) => disposed || routedPage.isClosed() || cancelledRequests.has(route.request()) || !!route.request().failure();
    const finishInactiveRoute = async (route: Route) => {
      try { await bounded('cancel-route', route.abort('aborted'), 1_000); }
      catch (error) { result.cancelledRouteErrors.push({ url: route.request().url(), error: String(error) }); }
    };
    await page.route('**/*', async route => {
      try {
        if (routeInactive(route)) return await finishInactiveRoute(route);
        const url = new URL(route.request().url());
        if (url.origin === appUrl) {
          if (url.pathname === '/api/maps/vworld/config') {
            if (scenario === 'close-config') await gate;
            else await delay(150);
            if (routeInactive(route)) return await finishInactiveRoute(route);
            return await json(route, { available: scenario === 'vworld-protocol' });
          }
          if (url.pathname === '/api/maps/vworld/frame') {
            const channel = JSON.stringify(url.searchParams.get('channel'));
            return await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>LOCAL VWORLD PROTOCOL FIXTURE<script>setTimeout(()=>parent.postMessage({type:'culture-vworld',channel:${channel},status:'ready'},location.origin),150)</script></body></html>` });
          }
          if (url.pathname === '/api/venues/building') {
            const requestNumber = ++buildingRequests;
            if (scenario === 'close-building' || scenario === 'chunk-failure' || (scenario === 'rapid-reopen' && requestNumber === 1)
              || (scenario === 'close-chunk' && expectedBuildingOrder === 'parallel')) await gate;
            else await delay(200);
            if (routeInactive(route)) return await finishInactiveRoute(route);
            if (scenario === 'background-retry') return await json(route, { ...building, building: { ...building.building, heightMeters: null, heightSource: 'unknown' } });
            if (scenario === 'rapid-reopen' && requestNumber > 1) return await json(route, { ...building, building: { ...building.building, heightMeters: 18 } });
            return await json(route, building);
          }
          if (scenario === 'chunk-failure' && isOsmRenderer(url.href)) return await route.abort('failed');
          if (scenario === 'close-chunk' && isOsmRenderer(url.href)) await gate;
          if (routeInactive(route)) return await finishInactiveRoute(route);
          return await route.continue();
        }
        if (url.origin === 'https://tile.openstreetmap.org' && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) {
          result.localTileRequests++;
          if (blockTiles) return await route.abort('failed');
          return await route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: tilePng });
        }
        if (route.request().resourceType() === 'image') return await route.fulfill({ contentType: 'image/svg+xml', body: tileSvg });
        external.push(`${url.origin}${url.pathname}`); return await route.abort('blockedbyclient');
      } catch (error) {
        // Closing an intentionally gated request is harness cleanup, not an app pageerror.
        if (routeInactive(route)) return await finishInactiveRoute(route);
        result.routeErrors.push({ url: route.request().url(), error: String(error) });
        try { await bounded('abort-after-route-error', route.abort('failed'), 1_000); }
        catch (abortError) { if (!routeInactive(route)) result.routeErrors.push({ url: route.request().url(), error: String(abortError), phase: 'abort-after-route-error' }); }
      }
    });
    result.phase = 'setup-navigation';
    const [mapResponse] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/map'),
      page.goto(`${appUrl}/#map`, { waitUntil: 'domcontentloaded' }),
    ]);
    const map = await mapResponse.json();
    const located = map.items.filter((item: any) => item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
      && item.latitude >= 33 && item.latitude <= 39 && item.longitude >= 124 && item.longitude <= 132).length;
    result.phase = 'setup-map-ready';
    await page.waitForFunction(count => document.querySelector('.results')?.getAttribute('aria-busy') === 'false'
      && [...document.querySelectorAll<HTMLElement>('[data-performance-count]')].reduce((sum, node) => sum + Number(node.dataset.performanceCount), 0) === count
      && !!document.querySelector('.venue-map-marker'), located);
    await page.locator('.venue-map-marker').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('.map-popup-3d').waitFor();
    await page.waitForTimeout(200);
    result.phase = 'scenario';
    return { page, releaseGate, allowTiles: () => { blockTiles = false; }, dispose, errors, external, failed, workers };
  } catch (error) {
    result.setupError = String(error);
    if (page && !page.isClosed()) result.failureState = await bounded('setup-failure-state', state(page), 1_500).catch(() => undefined);
    await dispose();
    throw error;
  }
}

async function state(page: Page) {
  return page.evaluate(() => {
    const probe = (window as any).__threeDProbe;
    return { time: performance.now(), fetches: probe.fetches, dom: probe.dom, longTasks: probe.longTasks, actionRequests: probe.actionRequests, clicks: probe.clicks,
      raf: { fired: probe.rafFired, pending: probe.rafPending.size }, resourceOverflow: probe.resourceOverflow,
      resources: performance.getEntriesByType('resource').filter(entry => /Venue3DDialog|VWorld3DDialog|\/api\/(maps\/vworld|venues\/building)|\/cesium\/|\/deps\/cesium/.test(entry.name)).map(entry => entry.toJSON()),
      canvases: document.querySelectorAll('dialog[open] canvas').length, iframeCount: document.querySelectorAll('.vworld-viewer iframe').length,
      openDialogs: document.querySelectorAll('dialog[open]').length, activeClass: document.activeElement?.className,
      focusInsideDialog: !!document.querySelector('dialog[open]')?.contains(document.activeElement) };
  });
}

async function open(page: Page) {
  const requestedAt = await page.evaluate(() => {
    const at = performance.now(); (window as any).__threeDProbe.actionRequests.push(at); return at;
  });
  await page.locator('.leaflet-popup').getByRole('button', { name: `${venue.venue || '공연장'} 3D로 보기`, exact: true }).click();
  const at = await page.evaluate(after => (window as any).__threeDProbe.clicks.find((time: number) => time >= after) as number | undefined, requestedAt);
  assert.ok(at !== undefined, '3D timing starts at the actual DOM click, after Playwright actionability waits');
  return at;
}

async function close(page: Page) {
  await page.locator('dialog[open]').getByRole('button', { name: '닫기', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 0);
  await page.waitForTimeout(300);
  const settled = await state(page);
  await page.waitForTimeout(200);
  const result = { ...await state(page), idleRafCallbacks: 0 };
  result.idleRafCallbacks = result.raf.fired - settled.raf.fired;
  assert.equal(result.canvases, 0); assert.equal(result.iframeCount, 0);
  assert.ok(result.idleRafCallbacks <= 1, 'closed viewer does not retain its continuous animation-frame loop');
  assert.equal(result.activeClass, 'map-popup-3d', 'closing the viewer restores its original popup action');
  return result;
}

function stages(actionAt: number, ready: any, provider: Scenario) {
  const fetch = (part: string, phase: string) => {
    // StrictMode may cancel a first effect before its replacement succeeds.
    const completed = ready.fetches.filter((entry: any) => entry.time >= actionAt && entry.url.includes(part) && entry.phase === 'headers').at(-1);
    return ready.fetches.find((entry: any) => entry.time >= actionAt && entry.url.includes(part) && entry.phase === phase && (completed === undefined || entry.id === completed.id))?.time;
  };
  const resource = (part: string) => ready.resources.find((entry: any) => entry.startTime >= (fetch(part, 'start') ?? actionAt) && entry.name.includes(part));
  const config = resource('/api/maps/vworld/config');
  const module = ready.resources.find((entry: any) => entry.startTime >= actionAt && (provider === 'osm' ? isOsmRenderer(entry.name)
    : /\/assets\/VWorld3DDialog-[^/]+\.js$/.test(new URL(entry.name).pathname) || new URL(entry.name).pathname.endsWith('/components/VWorld3DDialog.tsx')));
  const geometry = resource('/api/venues/building');
  const commit = ready.dom.find((entry: any) => entry.time >= actionAt && (provider === 'osm' ? entry.state.startsWith('osm:true:') : entry.state === 'vworld:ready'))?.time;
  return { actionAt, configStart: fetch('/api/maps/vworld/config', 'start'), configResponseEnd: config?.responseEnd,
    rendererChunkStart: module?.startTime, rendererChunkResponseEnd: module?.responseEnd, rendererChunkEncodedBytes: module?.encodedBodySize,
    rendererModuleAlreadyLoaded: !module, buildingStart: fetch('/api/venues/building', 'start'), buildingResponseEnd: geometry?.responseEnd,
    geometryOrProtocolCommitAt: commit, actionToCommitMs: commit === undefined ? undefined : commit - actionAt,
    chunkEndToBuildingStartMs: module && fetch('/api/venues/building', 'start') !== undefined ? fetch('/api/venues/building', 'start') - module.responseEnd : undefined };
}

try {
  scenariosLoop: for (const scenario of scenarios) for (let sample = 0; sample < (scenario === 'osm' || scenario === 'vworld-protocol' ? samples : 1); sample++) {
    if (Date.now() >= overallDeadline) { cleanupErrors.push('Overall probe deadline exceeded before next scenario'); break scenariosLoop; }
    const result: any = { scenario, sample, passed: false, phase: 'setup', errors: [], unexpectedExternal: [], failedRequests: [], workers: [], routeErrors: [], cancelledRouteErrors: [], cleanupErrors: [], localTileRequests: 0 };
    const scope: CaseScope = {};
    let current: Awaited<ReturnType<typeof setup>> | undefined;
    const operation = (async () => {
      current = await setup(scenario, result, scope);
      const { page } = current;
      const initial = await state(page);
      assert.equal(initial.fetches.length, 0, 'no config/building fetch before explicit 3D action');
      assert.equal(initial.resources.filter((entry: any) => /(?:Venue3DDialog|VWorld3DDialog)(?:-|\.tsx)/.test(entry.name)).length, 0, 'no renderer chunk before explicit 3D action');
      result.initial = initial;
      if (scenario === 'osm' || scenario === 'vworld-protocol') {
        result.opens = [];
        for (const temperature of ['first', 'second']) {
          const actionAt = await open(page);
          await page.locator(scenario === 'osm' ? '[data-testid="venue-3d"][data-ready="true"]' : '.vworld-viewer[data-status="ready"]').waitFor({ timeout: 35_000 });
          const ready: any = await state(page);
          const sequence = stages(actionAt, ready, scenario);
          assert.ok(sequence.configStart >= actionAt);
          if (sequence.rendererChunkStart !== undefined) assert.ok(sequence.rendererChunkStart >= sequence.configResponseEnd, 'selected renderer loads after config resolves');
          if (scenario === 'osm' && sequence.rendererChunkResponseEnd !== undefined) {
            assert.ok(sequence.buildingStart >= sequence.configResponseEnd, 'building request follows provider selection');
            if (expectedBuildingOrder === 'serial') assert.ok(sequence.buildingStart >= sequence.rendererChunkResponseEnd, 'serial baseline diagnostic: building follows the renderer');
            else assert.ok(sequence.buildingStart < sequence.rendererChunkResponseEnd, 'parallel candidate: building overlaps the selected renderer chunk');
          }
          assert.equal(ready.focusInsideDialog, true, 'pending-to-viewer transition keeps keyboard focus inside the modal');
          if (scenario === 'vworld-protocol') {
            assert.equal(ready.fetches.filter((entry: any) => entry.url.includes('/api/venues/building')).length, 0, 'VWorld never starts an OSM building request');
            assert.equal(ready.resources.filter((entry: any) => isOsmRenderer(entry.name) || /\/deps\/cesium/.test(entry.name)).length, 0, 'VWorld never loads Cesium');
          }
          if (scenario === 'osm') {
            ready.renderer = await page.locator('[data-testid="venue-3d"] canvas').first().evaluate(element => {
              const canvas = element as HTMLCanvasElement;
              const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
              if (!gl) return 'unavailable';
              const extension = gl.getExtension('WEBGL_debug_renderer_info');
              return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
            });
            assert.equal(await page.locator('[data-testid="venue-3d"]').getAttribute('data-geometry'), 'building');
            if (sample === 0 && temperature === 'first') {
              result.screenshot = resolve(dirname(args.out), `${basename(args.out, '.json')}-geometry.png`);
              await page.locator('dialog[open]').screenshot({ path: result.screenshot });
            }
          }
          const closed = await close(page);
          assert.ok(closed.raf.pending <= initial.raf.pending + 1, 'viewer close releases its animation-frame loop');
          result.opens.push({ temperature, actionAt, readyAt: ready.time, actionToReadyMs: ready.time - actionAt, sequence, ready, closed, workersAfterClose: current.workers.map(worker => ({ ...worker })) });
        }
      } else if (scenario === 'background-retry') {
        result.actionAt = await open(page);
        const viewer = page.locator('[data-testid="venue-3d"][data-ready="true"]');
        await viewer.waitFor({ timeout: 35_000 });
        const canvas = await viewer.locator('canvas').first().elementHandle();
        assert.ok(canvas);
        const height = viewer.getByRole('slider', { name: '모형 높이 가정' });
        await height.focus(); await height.press('End');
        assert.equal(await height.inputValue(), '80');
        await viewer.getByRole('button', { name: '위에서 보기', exact: true }).click();
        await viewer.getByRole('button', { name: '배경만 다시 불러오기', exact: true }).waitFor({ timeout: 15_000 });
        result.beforeBackgroundRetry = await state(page);
        current.allowTiles();
        await viewer.getByRole('button', { name: '배경만 다시 불러오기', exact: true }).click();
        await page.waitForTimeout(700);
        assert.equal(await canvas.evaluate(node => node.isConnected && node === document.querySelector('[data-testid="venue-3d"] canvas')), true, 'background retry retains the same Viewer canvas');
        assert.equal(await height.inputValue(), '80');
        assert.equal(await viewer.getByRole('button', { name: '위에서 보기', exact: true }).getAttribute('aria-pressed'), 'true');
        assert.equal(await viewer.getAttribute('data-geometry'), 'building');
        result.afterBackgroundRetry = await state(page);
        assert.equal(result.afterBackgroundRetry.fetches.filter((entry: any) => entry.url.includes('/api/venues/building') && entry.phase === 'start').length,
          result.beforeBackgroundRetry.fetches.filter((entry: any) => entry.url.includes('/api/venues/building') && entry.phase === 'start').length, 'background retry does not repeat building lookup');
        result.backgroundStateAfterRetry = await viewer.getAttribute('data-background-state');
        result.closed = await close(page);
      } else if (scenario === 'rapid-reopen') {
        const pending = page.waitForRequest(request => new URL(request.url()).pathname === '/api/venues/building');
        [result.firstActionAt] = await Promise.all([open(page), pending]);
        await page.locator('dialog[open]').getByRole('button', { name: '닫기', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('dialog[open]'));
        result.reopenActionAt = await open(page);
        await page.locator('[data-testid="venue-3d"][data-ready="true"]').waitFor({ timeout: 35_000 });
        await page.getByText('실제 외곽 · 높이 18m (OSM 기록)', { exact: true }).waitFor();
        result.reopened = await state(page);
        assert.ok(result.reopened.fetches.some((entry: any) => entry.url.includes('/api/venues/building') && entry.phase === 'abort'));
        current.releaseGate(); await page.waitForTimeout(500);
        assert.equal(await page.getByText('실제 외곽 · 높이 18m (OSM 기록)', { exact: true }).count(), 1, 'late first opening cannot replace the second building');
        result.afterLateResponse = await state(page);
        assert.equal(result.afterLateResponse.openDialogs, 1);
        assert.equal(result.afterLateResponse.canvases, 1);
        result.closed = await close(page);
      } else if (scenario === 'chunk-failure') {
        result.actionAt = await open(page);
        await page.getByRole('heading', { name: '3D 지도를 불러오지 못했습니다', exact: true }).waitFor();
        await page.getByText('연결 상태를 확인하고 페이지를 새로고침한 뒤 다시 열어주세요. 공연 검색은 계속 이용할 수 있습니다.', { exact: true }).waitFor();
        if (expectedBuildingOrder === 'parallel') await page.waitForFunction(() => (window as any).__threeDProbe.fetches.some((entry: any) => entry.url.includes('/api/venues/building') && entry.phase === 'abort'));
        result.afterChunkFailure = await state(page);
        assert.equal(result.afterChunkFailure.canvases, 0);
        if (expectedBuildingOrder === 'parallel') assert.ok(result.afterChunkFailure.fetches.some((entry: any) => entry.url.includes('/api/venues/building') && entry.phase === 'abort'), 'renderer load failure unmounts the request owner');
        current.releaseGate(); await page.waitForTimeout(300);
        result.closed = await close(page);
      } else {
        const request = page.waitForRequest(request => scenario === 'close-config' ? new URL(request.url()).pathname === '/api/maps/vworld/config'
          : scenario === 'close-building' ? new URL(request.url()).pathname === '/api/venues/building' : isOsmRenderer(request.url()));
        const [, actionAt] = await Promise.all([request, open(page)]);
        result.actionAt = actionAt;
        result.closed = await close(page);
        if (scenario !== 'close-chunk' || expectedBuildingOrder === 'parallel') assert.ok(result.closed.fetches.some((entry: any) => entry.phase === 'abort'), 'closing pending 3D aborts its fetch');
        current.releaseGate();
        await page.waitForTimeout(500);
        result.afterLateResponse = await state(page);
        assert.equal(result.afterLateResponse.openDialogs, 0); assert.equal(result.afterLateResponse.canvases, 0);
        const buildingStarts = (value: any) => value.fetches.filter((entry: any) => entry.url.includes('/api/venues/building') && entry.phase === 'start').length;
        if (scenario === 'close-config' || (scenario === 'close-chunk' && expectedBuildingOrder === 'serial')) assert.equal(buildingStarts(result.afterLateResponse), 0, 'closed pending module never initializes a viewer or building request');
        else assert.equal(buildingStarts(result.afterLateResponse), buildingStarts(result.closed), 'late module/response never starts a new building request after close');
      }
      assert.deepEqual(current.errors, []); assert.deepEqual(current.external, []); assert.deepEqual(result.routeErrors, []);
      result.passed = true;
      result.phase = 'complete';
    })();
    try {
      await bounded(`${scenario} scenario`, operation, Math.max(1, Math.min(CASE_TIMEOUT_MS, overallDeadline - Date.now())));
    } catch (error) {
      result.error = String(error);
      result.timedOut = error instanceof ProbeTimeout;
      const failurePage = (current as Awaited<ReturnType<typeof setup>> | undefined)?.page;
      if (failurePage && !failurePage.isClosed()) result.failureState = await bounded('failure-state', state(failurePage), 1_500).catch(() => undefined);
    } finally {
      // Preserve the outcome before cleanup so even a cleanup watchdog has evidence.
      rows.push(result);
      await saveJson(args.out, { status: 'cleaning-case', before, rows });
      try { if (scope.dispose) await bounded('scenario-dispose', scope.dispose(), 8_000); }
      catch (error) { result.cleanupErrors.push({ phase: 'scenario-dispose', error: String(error) }); }
      finally {
        if (result.timedOut) {
          try { await bounded('timed-out-scenario-drain', operation.catch(() => undefined), 2_000); }
          catch (error) { result.cleanupErrors.push({ phase: 'scenario-drain', error: String(error) }); }
        }
        if (result.timedOut || result.cleanupErrors.length || result.routeErrors.length) result.passed = false;
        await saveJson(args.out, { status: 'partial', before, rows });
      }
    }
    if (result.timedOut || result.cleanupErrors.length) break scenariosLoop;
  }
} finally {
  try { await bounded('browser-close', browser.close(), 10_000); }
  catch (error) { cleanupErrors.push(`browser-close: ${String(error)}`); }
  finally {
    try { if (developmentServer) await bounded('development-server-close', developmentServer.close(), 10_000); }
    catch (error) { cleanupErrors.push(`development-server-close: ${String(error)}`); }
    finally {
      try { await bounded('fixture-stop', fixture.stop(), 15_000); }
      catch (error) { cleanupErrors.push(`fixture-stop: ${String(error)}`); }
      finally { await saveJson(args.out, { status: 'partial', before, cleanupErrors, rows }); }
    }
  }
}
const after = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
const workspaceClientAfter = development ? await clientFingerprint(workspace) : undefined;
const report = { version: 1, measuredAt: new Date().toISOString(), scope: 'Deterministic local 3D sequence/cleanup: real snapshot coordinate, synthetic rectangular building, local image substitutes, fixed config150ms/building200ms waits; VWorld is a protocol-only iframe fixture. These are not live provider, real building accuracy, or physical GPU quality measurements.',
  browser: browser.version(), snapshot: { hash: info.hash, count: info.count }, venue: { id: venue.id, title: venue.title, latitude: lat, longitude: lon },
  timeoutLimits: { caseMs: CASE_TIMEOUT_MS, overallWorkMs: OVERALL_TIMEOUT_MS, cleanupMs: 25_000 },
  expectedBuildingOrder, runtime: development ? 'Vite development with React StrictMode effect replay' : 'production build',
  ...(development ? { workspaceClientBefore, workspaceClientAfter, workspaceClientStable: workspaceClientBefore!.hash === workspaceClientAfter!.hash } : {}),
  sourceStable: before.source.hash === after.source.hash, clientStable: before.client.hash === after.client.hash, before, after, cleanupErrors, rows };
await saveJson(args.out, report);
console.log(JSON.stringify({ out: args.out, sourceStable: report.sourceStable, clientStable: report.clientStable, rows: rows.map(row => ({ scenario: row.scenario, passed: row.passed, error: row.error, opens: row.opens?.map((open: any) => ({ temperature: open.temperature, actionToReadyMs: open.actionToReadyMs, renderer: open.ready.renderer })) })) }, null, 2));
if (!report.sourceStable || !report.clientStable || (development && !report.workspaceClientStable) || cleanupErrors.length || rows.some(row => !row.passed)) process.exitCode = 1;
