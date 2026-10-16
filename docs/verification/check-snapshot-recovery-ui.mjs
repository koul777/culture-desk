import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const [originalBoot, originalSearch] = await Promise.all(['/api/bootstrap', '/api/performances?from=2026-10-01&to=2027-01-16'].map(async path => (await fetch('http://127.0.0.1:4317' + path)).json()));
const fallback = { mode: 'snapshot', snapshotAt: '2026-10-16T11:00:00.000Z', reason: 'database_unavailable' };
const report = { method: 'Local application with frozen real read payloads plus explicit outage/recovery metadata fixtures; no provider keys or live writes.', checks: {}, postRequests: 0, errors: [] };
const browser = await chromium.launch({ headless: true });
try {
  let bootFallback = true;
  let queryFallback = true;
  let reads = 0;
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul' });
  await page.clock.install();
  page.on('pageerror', error => report.errors.push(String(error)));
  await page.route('**/api/**', async route => {
    if (route.request().method() !== 'GET') { report.postRequests++; return route.abort(); }
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/bootstrap') {
      reads++;
      const boot = { ...originalBoot, deployment: 'cloud', automaticRefresh: { status: 'complete', day: '2026-10-16', from: '2026-10-01', to: '2027-01-16', lastSuccessAt: fallback.snapshotAt, updatedAt: fallback.snapshotAt, counts: null, error: null,
        schedule: { timezone: 'Asia/Seoul', primary: '04:17', retries: ['06:47', '12:47', '20:47'] }, ...originalBoot.automaticRefresh, enabled: true },
        runs: bootFallback ? [{ id: 999, source: 'kopis', cityId: 'wonju', from: '2026-10-01', to: '2027-01-16', detailOnly: false, state: 'running', createdAt: fallback.snapshotAt, updatedAt: fallback.snapshotAt, tasksTotal: 10, tasksDone: 2, tasksFailed: 0, items: 1, excluded: 0, review: 0, error: '' }] : [], ...(bootFallback ? { fallback } : {}) };
      return route.fulfill({ json: boot });
    }
    if (path === '/api/performances') return route.fulfill({ json: { ...originalSearch, ...(queryFallback ? { fallback } : {}) } });
    return route.continue();
  });
  await page.goto('http://127.0.0.1:5178');
  const notice = page.getByText('저장된 공연 자료로 조회 중입니다', { exact: true });
  await notice.waitFor();
  await page.locator('.performance-card').first().waitFor();
  const warning = await notice.locator('..').innerText();
  assert.match(warning, /2026/);
  assert.match(warning, /자동 갱신·추가 수집은 일시 중단/);
  assert.equal(await page.getByRole('button', { name: '엑셀 내보내기', exact: true }).isEnabled(), true);
  report.checks.snapshotSearch = { datedNotice: warning, exportEnabled: true, cards: await page.locator('.performance-card').count() };
  await page.locator('.sidebar a[href="#connection"]').click();
  await page.getByRole('heading', { name: '데이터 연결', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '수집 시작', exact: true }).isDisabled(), true);
  assert.match(await page.locator('.automatic-refresh-panel').innerText(), /일시 중단/);
  assert.doesNotMatch(await page.locator('.automatic-refresh-panel').innerText(), /브라우저를 닫아도/);
  report.checks.collectionDisabled = true;
  report.checks.mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(report.checks.mobileOverflow, false);
  await page.screenshot({ path: 'docs/verification/snapshot-recovery-mobile.png' });
  const beforePoll = reads;
  await page.clock.fastForward(30_000);
  await page.waitForTimeout(20);
  assert.equal(reads, beforePoll);
  await page.clock.fastForward(31_000);
  await expect.poll(() => reads).toBe(beforePoll + 1);
  report.checks.sixtySecondRecoveryPoll = true;
  bootFallback = false; queryFallback = false;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await notice.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: '수집 시작', exact: true }).isEnabled(), true);
  report.checks.healthyBootstrapRestoresActions = true;
  queryFallback = true;
  await page.locator('.sidebar a[href="#search"]').click();
  await notice.waitFor();
  report.checks.searchFirstOutageVisible = true;
  assert.equal(await page.getByRole('button', { name: '엑셀 내보내기', exact: true }).isEnabled(), true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.postRequests, 0);
  report.success = true;
} catch (error) { report.success = false; report.failure = String(error); throw error; }
finally { await browser.close(); await writeFile('docs/verification/snapshot-recovery-ui.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
