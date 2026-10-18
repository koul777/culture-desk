import ExcelJS from 'exceljs';
import { test, expect, openPublished, expectTotal } from './helpers.js';

test('export waits for the typed search and its response, then records the displayed selection', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date('2026-10-18T10:00:00Z') });
  await openPublished(page);
  const button = page.getByRole('button', { name: '엑셀 내보내기', exact: true });
  await expect(button).toBeEnabled();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false, settled = false;
  const requests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/export.xlsx') requests.push(request.url());
  });
  await page.route('**/api/performances?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') !== '안동') return route.fallback();
    try {
      const response = await route.fetch();
      started = true;
      await held;
      await route.fulfill({ response });
    } finally { settled = true; }
  });
  try {
    // A paused browser clock makes the 350 ms debounce boundary deterministic.
    // The Node API fixture and the test's own deadline still use real time.
    // Slow CI startup must not make an absolute pause timestamp fall in the past.
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 5_000)));
    await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('안동');
    await expect(button, 'new text must not export the previous debounced selection').toBeDisabled({ timeout: 500 });
    expect(started).toBe(false);
    await page.clock.runFor(350);
    await expect.poll(() => started).toBe(true);
    await expect(page.locator('.results')).toHaveAttribute('aria-busy', 'true');
    await expect(button, 'the old visible rows are not the pending search result').toBeDisabled();
    expect(requests).toEqual([]);
    release();
    await expect.poll(() => settled).toBe(true);
    await expectTotal(page, 2);
    await expect(button).toBeEnabled();
    await page.clock.resume();

    const downloadReady = page.waitForEvent('download');
    await button.click();
    const download = await downloadReady;
    const output = testInfo.outputPath('settled-search.xlsx');
    await download.saveAs(output);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]).searchParams.get('q')).toBe('안동');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    const rows = workbook.getWorksheet('공연 목록')!;
    expect(rows.rowCount).toBe(3);
    expect([rows.getCell('B2').text, rows.getCell('B3').text].sort())
      .toEqual(['TEST 안동 무료 음악', 'TEST 안동 유료 연극']);
    expect(JSON.parse(workbook.getWorksheet('조회 근거')!.getCell('B3').text).q).toBe('안동');

    await page.getByRole('button', { name: /^상세 조건/ }).click();
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 5_000)));
    await page.getByLabel(/^관람 연령/).fill('전체');
    await expect(button, 'the independent age debounce also guards export').toBeDisabled();
    const ageResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/performances' && url.searchParams.get('age') === '전체';
    });
    await page.clock.runFor(350);
    await ageResponse;
    await expectTotal(page, 2);
    await expect(button).toBeEnabled();
    expect(requests).toHaveLength(1);
  } finally {
    release();
    await page.clock.resume();
    if (started) await expect.poll(() => settled).toBe(true);
    await testInfo.attach('export-selection.json', { contentType: 'application/json',
      body: JSON.stringify({ requests, started, settled }, null, 2) });
  }
});
