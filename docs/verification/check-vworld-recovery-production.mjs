import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

// Execute only after the release owner confirms the production alias is updated.
// No environment variables, credentials, request URLs, frame HTML, or SDK messages are logged.
const origin = 'https://culture-desk.vercel.app';
const output = 'docs/verification/vworld-recovery-production';
const report = { checkedAt: new Date().toISOString(), origin, method: 'Real production GET responses and actual VWorld iframe; all non-GET/HEAD requests blocked before transport. SDK ready does not verify individual-building coverage.',
  checks: {}, writeAttempts: { app: 0, provider: 0, other: 0 }, writesSent: 0, jsErrorCount: 0, consoleErrorCount: 0, screenshots: [] };
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
let stage = 'create-browser';
const latest = {};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Seoul' });
  await context.route('**/*', async route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) {
      const url = new URL(request.url());
      report.writeAttempts[url.origin === origin ? 'app' : url.hostname.endsWith('vworld.kr') ? 'provider' : 'other']++;
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', () => report.jsErrorCount++);
  page.on('console', message => { if (message.type() === 'error') report.consoleErrorCount++; });
  const reads = { config: 0, frame: 0, provider: 0 };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/maps/vworld/config') reads.config++;
    if (url.pathname === '/api/maps/vworld/frame') reads.frame++;
    if (url.hostname.endsWith('vworld.kr')) reads.provider++;
  });
  page.on('response', async response => {
    const path = new URL(response.url()).pathname;
    const key = path === '/api/performances' ? 'search' : path === '/api/map' ? 'map' : path === '/api/bootstrap' ? 'bootstrap' : null;
    if (key && response.ok()) {
      try { latest[key] = { filter: Object.fromEntries(new URL(response.url()).searchParams), data: await response.json() }; } catch { /* The page may close after verification. */ }
    }
  });
  const hasVenue = item => item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
    && item.latitude >= 33 && item.latitude <= 39 && item.longitude >= 124 && item.longitude <= 132;
  const count = text => Number(text.replace(/[^\d]/g, ''));
  const overflow = () => page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > innerWidth }));
  const compareMap = async (label, cities = undefined) => {
    const normalizedCities = value => value ? value.split(',').sort().join(',') : null;
    await expect.poll(() => ['search', 'map'].map(key => latest[key] ? normalizedCities(latest[key].filter.cities) : 'pending'), { timeout: 45000 })
      .toEqual([normalizedCities(cities), normalizedCities(cities)]);
    await page.waitForFunction(() => document.querySelector('.map-scope-note')?.textContent.includes('건 중 위치가 확인된') && !document.querySelector('.results[aria-busy="true"]'));
    await expect.poll(async () => {
      const located = latest.map.data.items.filter(hasVenue).length;
      const visible = await page.locator('[data-performance-count]').evaluateAll(nodes => nodes.reduce((sum, node) => sum + Number(node.dataset.performanceCount), 0));
      return visible === located && count(await page.locator('.result-total').innerText()) === latest.map.data.total;
    }, { timeout: 20000 }).toBe(true);
    const search = latest.search.data;
    const map = latest.map.data;
    assert.equal(search.total, map.total, label);
    assert.equal(map.items.length, map.total, label);
    assert.equal(map.truncated, false);
    return { searchTotal: search.total, mapTotal: map.total, returned: map.items.length, located: map.items.filter(hasVenue).length,
      awaitingCoordinates: map.items.filter(item => !hasVenue(item)).length, truncated: map.truncated, cities: cities ?? 'nationwide' };
  };

  stage = 'dated-snapshot-notice';
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('.performance-card').first().waitFor({ timeout: 45000 });
  const notice = page.getByText('저장된 공연 자료로 조회 중입니다', { exact: true });
  await notice.waitFor();
  await expect.poll(() => latest.bootstrap?.data.fallback?.mode).toBe('snapshot');
  const fallback = latest.bootstrap.data.fallback;
  assert.ok(Number.isFinite(Date.parse(fallback.snapshotAt)));
  const noticeText = await notice.locator('..').innerText();
  assert.match(noticeText, /\d{4}.*기준 저장 자료/);
  assert.match(noticeText, /자동 갱신·추가 수집은 일시 중단/);
  assert.equal(count(await page.locator('.result-total').innerText()), 5615);
  report.checks.snapshot = { mode: fallback.mode, snapshotAt: fallback.snapshotAt, reason: fallback.reason, total: latest.search.data.total };
  report.checks.initialVWorldRequests = { ...reads };
  assert.deepEqual(reads, { config: 0, frame: 0, provider: 0 });
  assert.match(await page.locator('.explore-region-bar .selected-regions').innerText(), /전국 모든 지역/);

  stage = 'nationwide-map';
  await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  report.checks.noneSelected = await compareMap('nationwide');
  assert.equal(report.checks.noneSelected.mapTotal, 5615);
  stage = 'selected-region-map';
  await page.locator('.explore-region-bar .region-trigger').click();
  const picker = page.getByRole('dialog', { name: '전국 지역 선택' });
  await picker.getByRole('searchbox', { name: '시도·시군구 검색' }).fill('여수');
  await picker.locator('.district-list .region-check').filter({ hasText: '여수' }).getByRole('checkbox').check();
  await picker.getByRole('searchbox', { name: '시도·시군구 검색' }).fill('원주');
  await picker.locator('.district-list .region-check').filter({ hasText: '원주' }).getByRole('checkbox').check();
  await picker.getByRole('button', { name: '2곳 적용', exact: true }).click();
  report.checks.someSelected = await compareMap('yeosu + wonju', 'yeosu,wonju');
  assert.ok(report.checks.someSelected.mapTotal > 0 && report.checks.someSelected.mapTotal < 5615);
  stage = 'all-selected-map';
  await page.locator('.explore-region-bar .region-trigger').click();
  await picker.getByRole('button', { name: '전국 전체 선택', exact: true }).click();
  await picker.getByRole('button', { name: '전국 공연 보기', exact: true }).click();
  report.checks.allSelected = await compareMap('all selected');
  assert.equal(report.checks.allSelected.mapTotal, 5615);

  stage = 'collection-disabled';
  await page.locator('.sidebar a[href="#connection"]').click();
  await page.getByRole('heading', { name: '데이터 연결', exact: true }).waitFor();
  await notice.waitFor();
  assert.equal(await page.getByRole('button', { name: '수집 시작', exact: true }).isDisabled(), true);
  assert.match(await page.locator('.automatic-refresh-panel').innerText(), /일시 중단/);
  assert.doesNotMatch(await page.locator('.automatic-refresh-panel').innerText(), /브라우저를 닫아도 자동갱신은 계속/);
  report.checks.collectionDisabled = true;

  stage = 'actual-vworld-open';
  await page.locator('.sidebar a[href="#search"]').click();
  const venueSearchResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/performances' && new URL(response.url()).searchParams.get('q') === '백운아트홀' && response.ok());
  await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('백운아트홀');
  await venueSearchResponse;
  const framesBefore = page.frames().length;
  await page.locator('.performance-card').filter({ hasText: '원주백운아트홀' }).first().locator('.card-3d-action').click();
  await page.locator('.vworld-viewer').waitFor({ timeout: 15000 });
  await expect.poll(async () => await page.locator('.vworld-viewer').getAttribute('data-status'), { timeout: 35000 }).not.toBe('loading');
  const status = await page.locator('.vworld-viewer').getAttribute('data-status');
  report.checks.vworld = { status, venue: '원주백운아트홀', actualProvider: true, individualBuildingVerified: false };
  assert.equal(status, 'ready');
  const iframe = page.locator('.vworld-viewer iframe');
  const frameOrigin = await iframe.evaluate(element => new URL(element.src).origin);
  assert.equal(frameOrigin, origin);
  const frame = await (await iframe.elementHandle()).contentFrame();
  assert.ok(frame);
  report.checks.vworld.sameOrigin = (await frame.evaluate(() => location.origin)) === origin;
  report.checks.vworld.canvasCount = await frame.locator('canvas').count();
  assert.equal(report.checks.vworld.sameOrigin, true);
  assert.ok(report.checks.vworld.canvasCount > 0);
  assert.ok(reads.provider > 0);
  // Inspect text only in memory. Abort screenshots if an authentication error exposes credential-like text.
  const assertSafeVisibleText = async () => {
    const visibleText = await frame.locator('body').innerText();
    const credentialText = /(?:api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s]+/i.test(visibleText)
      || /\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/i.test(visibleText);
    assert.equal(credentialText, false, 'Credential-like visible text prevents capture');
  };
  await assertSafeVisibleText();
  // SDK readiness precedes provider tile/texture delivery; allow real imagery to settle.
  await page.waitForTimeout(20000);
  report.checks.vworld.observedAfterReadyMs = 20000;
  report.checks.vworld.desktop = await overflow();
  assert.equal(report.checks.vworld.desktop.overflow, false);
  await page.screenshot({ path: `${output}-desktop.png` }); report.screenshots.push(`${output}-desktop.png`);
  stage = 'actual-vworld-mobile';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(750);
  await assertSafeVisibleText();
  report.checks.vworld.mobile = await overflow();
  assert.equal(report.checks.vworld.mobile.overflow, false);
  assert.equal(await page.locator('dialog[open]').count(), 1);
  await page.screenshot({ path: `${output}-mobile.png` }); report.screenshots.push(`${output}-mobile.png`);
  stage = 'close-cleanup';
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('.vworld-viewer').waitFor({ state: 'detached' });
  await expect.poll(() => page.frames().length).toBe(framesBefore);
  report.checks.vworld.iframeRemovedOnClose = true;
  report.checks.readOnly = Object.values(report.writeAttempts).every(count => count === 0);
  assert.equal(report.checks.readOnly, true);
  assert.equal(report.jsErrorCount, 0);
  report.success = true;
} catch (error) {
  report.success = false;
  report.failureStage = stage;
  // Never print raw browser/SDK exception messages: they can contain credential-bearing URLs.
  report.failureKind = error?.name === 'AssertionError' ? 'assertion' : error?.name === 'TimeoutError' ? 'timeout' : 'verification_error';
  report.lastResults = Object.fromEntries(['search', 'map'].filter(key => latest[key]).map(key => [key, { cities: latest[key].filter.cities ?? 'nationwide', total: latest[key].data.total, returned: latest[key].data.items?.length }]));
  if (stage === 'selected-region-map') report.selectorDiagnostic = String(error?.message ?? '').replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 800);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(`${output}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
