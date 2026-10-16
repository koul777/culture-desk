import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const origin = 'https://culture-desk.vercel.app';
const resume = process.argv.includes('--resume');
const report = resume ? JSON.parse(await readFile('docs/verification/collection-performance-ui.json', 'utf8')) : { checkedAt: new Date().toISOString(), origin, expectedBundle: 'index-CvamMX7-.js', transport: { neutralizedTicks: 0, otherWritesBlocked: [], writesSent: 0 }, checks: {}, jsErrors: [], consoleErrors: [] };
delete report.failure;
if (resume) report.resumedAt = new Date().toISOString();
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.route('**/api/**', async route => {
    const request = route.request();
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/cloud/tick') {
      report.transport.neutralizedTicks++;
      return route.fulfill({ json: { ok: true, steps: 0, active: true } });
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.transport.otherWritesBlocked.push({ method: request.method(), path: new URL(request.url()).pathname });
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.jsErrors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  const latest = {};
  page.on('response', async response => {
    const path = new URL(response.url()).pathname;
    const key = path === '/api/performances' ? 'search' : path === '/api/map' ? 'map' : path === '/api/bootstrap' ? 'bootstrap' : null;
    if (key && response.ok()) {
      try { latest[key] = { url: response.url(), value: await response.json() }; } catch { /* Page may close after the final check. */ }
    }
  });
  const overflow = () => page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > innerWidth }));
  const markerSummary = () => page.evaluate(() => ({
    markers: document.querySelectorAll('[data-performance-count]').length,
    clusters: document.querySelectorAll('.venue-cluster-marker').length,
    sum: [...document.querySelectorAll('[data-performance-count]')].reduce((sum, node) => sum + Number(node.dataset.performanceCount), 0),
  }));
  const hasVenue = item => item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
    && item.latitude >= 33 && item.latitude <= 39 && item.longitude >= 124 && item.longitude <= 132;
  const settle = async () => {
    await page.waitForFunction(() => !document.querySelector('.results[aria-busy="true"]') && /\d/.test(document.querySelector('.result-total')?.textContent || ''));
    await page.waitForFunction(() => document.querySelector('.map-scope-note')?.textContent.includes('건 중 위치가 확인된'));
    await page.waitForTimeout(100);
    await page.waitForFunction(() => {
      const count = document.querySelector('.map-status-summary span')?.textContent.match(/공연장 위치 ([\d,]+)건/);
      return count && [...document.querySelectorAll('[data-performance-count]')].reduce((n, node) => n + Number(node.dataset.performanceCount), 0) === Number(count[1].replace(/,/g, ''));
    }, null, { timeout: 15000 });
  };
  const checkTotals = async (label, expectedCities = null) => {
    // Wait for both responses belonging to the new filter, not a still-visible previous result.
    await expect.poll(() => ['search', 'map'].map(key => latest[key] ? new URL(latest[key].url).searchParams.get('cities') : 'pending'), { timeout: 30000 })
      .toEqual([expectedCities, expectedCities]);
    await settle();
    let pair;
    for (let attempt = 0; attempt < 3; attempt++) {
      pair = await Promise.all([latest.search.url, latest.map.url].map(async url => {
        const response = await page.request.get(url);
        assert.equal(response.status(), 200);
        return response.json();
      }));
      if (pair[0].total === pair[1].total) break;
      await page.waitForTimeout(500);
    }
    const [search, map] = pair;
    const markers = await markerSummary();
    assert.equal(search.total, map.total, `${label}: search/map total`);
    assert.equal(map.items.length, map.total, `${label}: all map items returned`);
    assert.equal(map.truncated, false);
    const uiTotal = Number((await page.locator('.result-total').innerText()).replace(/,/g, ''));
    assert.equal(uiTotal, latest.map.value.total, `${label}: displayed search/map total`);
    assert.equal(markers.sum, latest.map.value.items.filter(hasVenue).length, `${label}: located venue marker sum`);
    return { searchTotal: search.total, mapTotal: map.total, mapItems: map.items.length, truncated: map.truncated, uiTotal,
      located: map.items.filter(hasVenue).length, awaitingCoordinates: map.items.filter(item => !hasVenue(item)).length, ...markers,
      searchFilter: Object.fromEntries(new URL(latest.search.url).searchParams), mapFilter: Object.fromEntries(new URL(latest.map.url).searchParams) };
  };

  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('.performance-card').first().waitFor();
  report.bundle = await page.locator('script[type="module"]').first().getAttribute('src');
  assert.ok(report.bundle.includes(report.expectedBundle));
  if (!resume) {
  report.checks.defaultCards = await page.locator('.performance-grid').count() === 1;
  report.checks.defaultRegion = await page.locator('.explore-region-bar .selected-regions').innerText();
  assert.match(report.checks.defaultRegion, /전국 모든 지역/);
  await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  report.checks.nationwide = await checkTotals('nationwide');
  const firstMarker = await page.locator('[data-performance-count]').first().elementHandle();
  await page.evaluate(() => { for (let i = 0; i < 10; i++) document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(1000);
  report.checks.markerRetainedAfterRefresh = await firstMarker.evaluate(node => node.isConnected);
  assert.equal(report.checks.markerRetainedAfterRefresh, true);

  await page.locator('.explore-region-bar .region-trigger').click();
  const picker = page.getByRole('dialog', { name: '전국 지역 선택' });
  await picker.getByRole('searchbox', { name: '시도·시군구 검색' }).fill('여수');
  await picker.locator('.district-list .region-check').filter({ hasText: '여수' }).getByRole('checkbox').check();
  await picker.getByRole('searchbox', { name: '시도·시군구 검색' }).fill('원주');
  await picker.locator('.district-list .region-check').filter({ hasText: '원주' }).getByRole('checkbox').check();
  await picker.getByRole('button', { name: '2곳 적용', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.results-view-context')?.textContent.includes('2개 지역'));
  report.checks.selectedRegions = await checkTotals('selected regions', 'yeosu,wonju');
  assert.ok(report.checks.selectedRegions.searchTotal < report.checks.nationwide.searchTotal);
  assert.match(report.checks.selectedRegions.searchFilter.cities, /yeosu/);
  assert.match(report.checks.selectedRegions.searchFilter.cities, /wonju/);
  } else {
    await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
    await settle();
  }

  await page.locator('.explore-region-bar .region-trigger').click();
  const picker = page.getByRole('dialog', { name: '전국 지역 선택' });
  await picker.getByRole('button', { name: '전국 전체 선택', exact: true }).click();
  await picker.getByRole('button', { name: '전국 공연 보기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.results-view-context')?.textContent.startsWith('전국'));
  report.checks.allChecked = await checkTotals('all checked');
  assert.equal(report.checks.allChecked.searchFilter.cities, undefined);
  assert.equal(report.checks.allChecked.mapFilter.cities, undefined);
  report.checks.desktop = await overflow();
  assert.equal(report.checks.desktop.overflow, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '검색 결과가 보이도록 지도 맞추기' }).click();
  await page.waitForTimeout(300);
  report.checks.mobileMap = { ...await overflow(), ...await markerSummary() };
  assert.equal(report.checks.mobileMap.overflow, false);
  await page.locator('.map-result-layout').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/verification/collection-performance-mobile.png' });
  await page.locator('.explore-region-bar .region-trigger').click();
  report.checks.mobilePicker = await overflow();
  assert.equal(report.checks.mobilePicker.overflow, false);
  await picker.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '카드', exact: true }).click();
  report.checks.mobileCards = await overflow();
  assert.equal(report.checks.mobileCards.overflow, false);

  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('백운아트홀');
  await page.waitForResponse(response => response.url().includes('/api/performances?') && response.url().includes(encodeURIComponent('백운아트홀')) && response.ok());
  await page.locator('.performance-card').first().waitFor();
  await page.locator('.card-3d-action').first().click();
  await page.locator('.venue-3d[data-ready="true"][data-geometry="building"]').waitFor({ timeout: 45000 });
  report.checks.venue3D = { info: await page.locator('.venue-3d-info').innerText(), heightKind: await page.locator('.venue-3d').getAttribute('data-height-kind'), canvas: await page.locator('.venue-3d-canvas canvas').count() };
  assert.match(report.checks.venue3D.info, /6m/);
  assert.equal(report.checks.venue3D.canvas, 1);
  await page.screenshot({ path: 'docs/verification/collection-performance-3d.png' });
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('.venue-3d').waitFor({ state: 'detached' });
  report.bootstrap = { pendingDetails: latest.bootstrap?.value.pendingDetails, activeRuns: latest.bootstrap?.value.runs.filter(run => ['running', 'queued', 'partial'].includes(run.state)).length };
  assert.deepEqual(report.jsErrors, []);
  assert.deepEqual(report.transport.otherWritesBlocked, []);
  report.success = true;
} catch (error) {
  report.success = false;
  report.failure = String(error);
  throw error;
} finally {
  await writeFile('docs/verification/collection-performance-ui.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
