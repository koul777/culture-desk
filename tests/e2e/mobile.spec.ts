import { test, expect, openPublished, expectTotal, selectAndong, expectNoHorizontalOverflow } from './helpers.js';

test('mobile cards, region selector, detail, table and map fit a 375px viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPublished(page);
  await expectNoHorizontalOverflow(page);
  await expect(page.locator('.explore-head-actions')).toBeHidden();
  await expect(page.locator('.region-search-help')).toBeHidden();
  for (const control of [
    page.getByRole('button', { name: '다음 페이지', exact: true }),
    page.getByRole('button', { name: /^지역 선택/ }).first(),
    page.getByRole('button', { name: '지도 + 목록', exact: true }),
    page.getByRole('button', { name: '엑셀 내보내기', exact: true }),
  ]) {
    const bounds = await control.boundingBox();
    expect(bounds?.width, 'touch target width').toBeGreaterThanOrEqual(44);
    expect(bounds?.height, 'touch target height').toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: testInfo.outputPath('mobile-overview.png') });
  await page.locator('.performance-card').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('mobile-cards.png') });
  await page.locator('.results-foot').screenshot({ path: testInfo.outputPath('mobile-pagination.png') });
  await page.getByRole('button', { name: /^지역 선택/ }).first().click();
  const regions = page.getByRole('dialog', { name: '전국 지역 선택' });
  await expect(regions).toBeVisible();
  await expect(regions.locator('.region-modal-sub')).toBeVisible();
  await expect(regions.locator('.region-modal-sub')).toContainText('선택하지 않거나 모두 체크하면 전국을 조회합니다.');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-regions.png') });
  await regions.getByRole('button', { name: '취소', exact: true }).click();
  await selectAndong(page);
  await page.getByRole('button', { name: 'TEST 안동 무료 음악', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'TEST 안동 무료 음악' });
  await expect(detail).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('mobile-detail.png') });
  await detail.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '표', exact: true }).click();
  await expect(page.locator('.search-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.explore-head-actions')).toBeHidden();
  await expect(page.locator('.region-search-help')).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  await expect(page.locator('.map-scope-note')).toContainText('검색 결과 2건');
  await expectNoHorizontalOverflow(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const intercepted = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/performances?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') !== '무료') return route.fallback();
    started();
    await held;
    return route.fallback();
  });
  try {
    await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('무료');
    await intercepted;
    const loading = page.locator('.results-actions > .loading-inline');
    await expect(loading).toBeVisible();
    const controls = await page.getByRole('group', { name: '공연 보기 방식' }).boundingBox();
    const label = await loading.boundingBox();
    expect(label!.y, 'mobile loading label occupies its own row below view controls').toBeGreaterThanOrEqual(controls!.y + controls!.height);
    await expectNoHorizontalOverflow(page);
    await page.locator('.results-actions').screenshot({ path: testInfo.outputPath('mobile-loading.png') });
  } finally { release(); }
  await expectTotal(page, 1);
  await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('');
  await expectTotal(page, 2);
  await page.locator('.map-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('mobile-map.png') });
  await page.getByRole('button', { name: '카드', exact: true }).click();
  await expectTotal(page, 2);
  await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('없는공연');
  await expectTotal(page, 0);
  await expect(page.getByRole('heading', { name: '선택 조건의 등록 자료 0건' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const endDate = page.getByLabel('빠른 조회 종료일', { exact: true });
  await endDate.fill('2026-01-01');
  await expect(endDate).toHaveAttribute('aria-invalid', 'true');
  await expect(endDate).toHaveAccessibleDescription('시작일이 종료일보다 늦습니다. 기간을 다시 선택하세요.');
  await expect(page.getByRole('alert').filter({ hasText: '시작일이 종료일보다 늦습니다.' })).toBeVisible();
  await expect(page.getByRole('button', { name: '엑셀 내보내기', exact: true })).toBeDisabled();
  await endDate.fill('2026-12-31');
  await expect(endDate).toHaveAttribute('aria-invalid', 'false');
  await page.getByRole('searchbox', { name: '공연명·공연장 검색' }).fill('');
  await expectTotal(page, 2);
});
