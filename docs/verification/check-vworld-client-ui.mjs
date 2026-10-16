import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const report = { method: 'Local real app with config and same-origin iframe fixtures. No real VWorld SDK or building imagery; all API writes blocked.', checks: {}, writesBlocked: 0, errors: [] };
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.clock.install();
  page.on('pageerror', error => report.errors.push(String(error)));
  let available = true;
  const requests = { config: 0, frame: 0, sdk: 0 };
  page.on('request', request => { if (/vworld\.kr/.test(request.url())) requests.sdk++; });
  await page.route('**/api/**', async route => {
    if (route.request().method() !== 'GET') { report.writesBlocked++; return route.abort(); }
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/maps/vworld/config') { requests.config++; return route.fulfill({ json: { available } }); }
    if (path === '/api/maps/vworld/frame') {
      requests.frame++;
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ko"><meta charset="utf-8"><style>body{font:16px sans-serif;background:#e1ebe5;padding:24px}button{min-height:44px}</style><h2>연결 시험 프레임</h2><p>실제 브이월드 지도나 건물 영상이 아닙니다.</p><button>지도 키보드 시험</button></html>' });
    }
    return route.continue();
  });
  await page.goto('http://127.0.0.1:5178');
  await page.locator('.performance-card').first().waitFor();
  assert.deepEqual(requests, { config: 0, frame: 0, sdk: 0 });
  report.checks.initialRequests = { ...requests };
  const open = async () => { await page.locator('.card-3d-action').first().click(); await page.locator('.vworld-viewer iframe').waitFor(); };
  const frame = async () => await (await page.locator('.vworld-viewer iframe').elementHandle()).contentFrame();
  const signal = async (status, wrong = false) => (await frame()).evaluate(({ status, wrong }) => parent.postMessage({ type: 'culture-vworld', channel: wrong ? 'wrong' : new URL(location.href).searchParams.get('channel'), status }, location.origin), { status, wrong });
  await open();
  assert.equal(await page.locator('dialog[open]').count(), 1);
  const channel = new URL(await page.locator('.vworld-viewer iframe').getAttribute('src'), 'http://127.0.0.1:5178').searchParams.get('channel');
  assert.match(channel, /^[a-zA-Z0-9]{1,80}$/);
  await page.evaluate(channel => window.postMessage({ type: 'culture-vworld', channel, status: 'ready' }, location.origin), channel);
  await signal('ready', true);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.vworld-viewer').getAttribute('data-status'), 'loading');
  await signal('ready');
  await page.locator('.vworld-viewer[data-status="ready"]').waitFor();
  report.checks.trustedFrameOnly = true;
  report.checks.mobile = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, dialogs: document.querySelectorAll('dialog[open]').length, buttonMinHeight: Math.min(...[...document.querySelectorAll('.vworld-viewer button')].map(button => button.getBoundingClientRect().height)) }));
  assert.equal(report.checks.mobile.scrollWidth, 390);
  assert.ok(report.checks.mobile.buttonMinHeight >= 44);
  await page.screenshot({ path: 'docs/verification/vworld-client-mobile-fixture.png' });
  await (await frame()).getByRole('button', { name: '지도 키보드 시험' }).focus();
  await page.keyboard.press('Escape');
  await page.locator('.vworld-viewer').waitFor({ state: 'detached', timeout: 3000 });
  report.checks.escapeFromIframe = true;
  await open();
  const beforeRetry = await page.locator('.vworld-viewer iframe').getAttribute('src');
  await signal('error');
  await page.locator('.vworld-viewer[data-status="error"]').waitFor();
  assert.equal(await page.locator('.vworld-viewer iframe').count(), 0);
  await page.getByRole('button', { name: '다시 시도', exact: true }).click();
  await page.locator('.vworld-viewer iframe').waitFor();
  assert.notEqual(await page.locator('.vworld-viewer iframe').getAttribute('src'), beforeRetry);
  await page.clock.fastForward(30_001);
  await page.locator('.vworld-viewer[data-status="error"]').waitFor();
  assert.equal(await page.locator('.vworld-viewer iframe').count(), 0);
  assert.match(await page.locator('.vworld-error').innerText(), /30초/);
  report.checks.errorRetryTimeoutUnmount = true;
  await page.screenshot({ path: 'docs/verification/vworld-client-timeout-fixture.png' });
  await page.getByRole('button', { name: '기존 외곽 모형 보기', exact: true }).click();
  await page.locator('.venue-3d').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.vworld-viewer iframe').count(), 0);
  assert.equal(await page.locator('dialog[open]').count(), 1);
  report.checks.manualFallback = true;
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('.venue-3d').waitFor({ state: 'detached' });
  available = false;
  const framesBefore = requests.frame;
  await page.locator('.card-3d-action').first().click();
  await page.locator('.venue-3d').waitFor({ timeout: 30000 });
  assert.equal(requests.frame, framesBefore);
  report.checks.unconfiguredAutomaticFallback = true;
  assert.equal(await page.locator('dialog[open]').count(), 1);
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  report.requests = { ...requests };
  assert.deepEqual(report.errors, []);
  assert.equal(requests.sdk, 0);
  assert.equal(report.writesBlocked, 0);
  report.success = true;
} catch (error) { report.success = false; report.failure = String(error); throw error; }
finally { await writeFile('docs/verification/vworld-client-ui.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); await browser.close(); }
