import { test as base, expect, type Page } from '@playwright/test';

export { expect };
export const test = base.extend<{ offlineGuard: void }>({
  offlineGuard: [async ({ page }, use, testInfo) => {
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) {
        unexpected.push(`${request.method()} ${request.url()}`);
      }
    });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://127.0.0.1:4339') return route.continue();
      if (url.hostname === 'tile.openstreetmap.org') {
        // Explicitly synthetic background; no tiles or other resources leave the machine.
        return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e8edf0"/><path d="M0 0H256V256" fill="none" stroke="#d4dde2"/><text x="8" y="20" font-size="10" fill="#80909b">OFFLINE QA</text></svg>' });
      }
      unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    });
    await use();
    await testInfo.attach('browser-guard.json', { body: JSON.stringify({ unexpected, errors }, null, 2), contentType: 'application/json' });
    expect(unexpected, 'published UI must remain read-only and use no unexpected remote resources').toEqual([]);
    expect(errors, 'browser runtime errors').toEqual([]);
  }, { auto: true }],
});

export async function openPublished(page: Page) {
  const bootResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap');
  await page.goto('/');
  const response = await bootResponse;
  expect(response.headers()['x-culture-data-mode']).toBe('published');
  const boot = await response.json();
  expect(boot.published.mode).toBe('published');
  expect(boot.cities).toHaveLength(230);
  expect(boot.runs).toEqual([]);
  await expect(page.getByRole('heading', { name: '전국 주요 공연 검색.' })).toBeVisible();
  await expectTotal(page, 36);
}

export async function expectTotal(page: Page, total: number) {
  await expect(page.locator('.result-total')).toHaveText(String(total));
  await expect(page.getByRole('region', { name: new RegExp(`^공연 목록 ${total}$`) })).toHaveAttribute('aria-busy', 'false');
}

export async function selectAndong(page: Page) {
  await page.getByRole('button', { name: /^지역 선택/ }).first().click();
  const dialog = page.getByRole('dialog', { name: '전국 지역 선택' });
  await dialog.getByRole('searchbox', { name: '시도·시군구 검색' }).fill('안동');
  await dialog.getByRole('checkbox', { name: /^안동/ }).check();
  await dialog.getByRole('button', { name: '1곳 적용' }).click();
  await expect(dialog).not.toBeVisible();
  await expectTotal(page, 2);
}

export async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({ width: document.documentElement.clientWidth, innerWidth: window.innerWidth, scroll: document.documentElement.scrollWidth,
    dialogs: [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].map(dialog => ({ client: dialog.clientWidth, scroll: dialog.scrollWidth })) }));
  await test.info().attach('horizontal-overflow.json', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
  expect(metrics.scroll, `page horizontal overflow: ${JSON.stringify(metrics)}`).toBeLessThanOrEqual(metrics.width + 1);
  for (const dialog of metrics.dialogs) expect(dialog.scroll, 'dialog horizontal overflow').toBeLessThanOrEqual(dialog.client + 1);
}
