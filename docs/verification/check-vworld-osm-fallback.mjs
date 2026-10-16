import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const report = { method: 'Real local building API seed and Cesium WebGL; config explicitly unavailable; only OSM imagery requests delayed 20 seconds then failed. No VWorld rendering claim.', tileRequests: 0, buildingRequests: 0, writes: 0, errors: [] };
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
const waits = new Set();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => report.errors.push(String(error)));
  let shape;
  page.on('response', async response => {
    if (response.url().includes('/api/venues/building?') && response.ok()) shape = await response.json();
  });
  await page.route('**/api/**', async route => {
    if (route.request().method() !== 'GET') { report.writes++; return route.abort(); }
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/maps/vworld/config') return route.fulfill({ json: { available: false } });
    if (path === '/api/venues/building') report.buildingRequests++;
    return route.continue();
  });
  await page.route('https://tile.openstreetmap.org/**', async route => {
    report.tileRequests++;
    await new Promise(resolve => {
      const release = () => { clearTimeout(timer); waits.delete(release); resolve(); };
      const timer = setTimeout(release, 20_000); waits.add(release);
    });
    try { await route.abort('failed'); } catch { /* Closing the verified viewer cancels pending tiles. */ }
  });
  await page.goto('http://127.0.0.1:5178');
  await page.locator('.performance-card').first().waitFor();
  await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('백운아트홀');
  await page.waitForResponse(response => response.url().includes('/api/performances?') && response.url().includes(encodeURIComponent('백운아트홀')) && response.ok());
  const start = performance.now();
  await page.locator('.card-3d-action').first().click();
  const ready = page.locator('.venue-3d[data-ready="true"][data-geometry="building"]');
  await ready.waitFor({ timeout: 12000 });
  report.readyMs = Math.round(performance.now() - start);
  report.initial = await ready.evaluate(node => ({ ready: node.dataset.ready, background: node.dataset.backgroundState, opacity: getComputedStyle(node.querySelector('.venue-3d-canvas')).opacity, disabledControls: node.querySelectorAll('.venue-3d-controls button:disabled').length, width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(report.readyMs < 12000);
  assert.equal(report.initial.background, 'loading');
  assert.equal(report.initial.opacity, '1');
  assert.equal(report.initial.disabledControls, 0);
  assert.equal(report.initial.width, report.initial.scrollWidth);
  assert.equal(shape.status, 'available');
  assert.equal(shape.building.heightMeters, 6);
  report.building = { performanceId: shape.performanceId, osmId: shape.building.osmId, heightMeters: shape.building.heightMeters, heightSource: shape.building.heightSource };
  await page.getByRole('button', { name: '오른쪽으로 회전', exact: true }).click();
  await page.locator('.venue-3d[data-background-state="timeout"]').waitFor({ timeout: 15000 });
  const canvas = page.locator('.venue-3d-canvas canvas');
  const handle = await canvas.elementHandle();
  const before = await canvas.screenshot();
  const shapeInfo = await page.locator('.venue-3d-info > strong').innerText();
  const requestsBefore = report.buildingRequests;
  const tilesBefore = report.tileRequests;
  await page.getByRole('button', { name: '배경만 다시 불러오기', exact: true }).click();
  await page.waitForTimeout(500);
  const after = await canvas.screenshot();
  report.retry = {
    buildingRequestsBefore: requestsBefore, buildingRequestsAfter: report.buildingRequests,
    newTileRequests: report.tileRequests - tilesBefore,
    sameCanvas: await handle.evaluate(node => node === document.querySelector('.venue-3d-canvas canvas')),
    modelTextUnchanged: shapeInfo === await page.locator('.venue-3d-info > strong').innerText(),
    exactCanvasPixelsUnchanged: before.equals(after),
    beforeSha256: createHash('sha256').update(before).digest('hex'), afterSha256: createHash('sha256').update(after).digest('hex'),
    ready: await ready.getAttribute('data-ready'), opacity: await page.locator('.venue-3d-canvas').evaluate(node => getComputedStyle(node).opacity),
    disabledControls: await page.locator('.venue-3d-controls button:disabled').count(),
  };
  assert.equal(report.retry.buildingRequestsAfter, requestsBefore);
  assert.ok(report.retry.newTileRequests > 0);
  assert.equal(report.retry.sameCanvas, true);
  assert.equal(report.retry.modelTextUnchanged, true);
  assert.equal(report.retry.exactCanvasPixelsUnchanged, true);
  assert.equal(report.retry.ready, 'true');
  assert.equal(report.retry.opacity, '1');
  assert.equal(report.retry.disabledControls, 0);
  await page.screenshot({ path: 'docs/verification/vworld-osm-fallback.png' });
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('.venue-3d').waitFor({ state: 'detached' });
  assert.deepEqual(report.errors, []);
  assert.equal(report.writes, 0);
  report.success = true;
} catch (error) { report.success = false; report.failure = String(error); throw error; }
finally {
  for (const release of [...waits]) release();
  await browser.close();
  await writeFile('docs/verification/vworld-osm-fallback.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
