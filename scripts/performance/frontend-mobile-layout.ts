import assert from 'node:assert/strict';
import { chromium, devices, type Browser, type BrowserContext } from '@playwright/test';
import { basename, dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { argumentsOf, clientFingerprint, saveJson, sha256, snapshotInfo, sourceFingerprint, workspace } from './common.js';
import { startBrowserFixture } from './browser-fixture.js';

const args = argumentsOf(), root = resolve(args.root ?? workspace);
assert.ok(args.out, '--out is required');
const widths = (args.widths ?? '375,320').split(',').map(Number);
const textScale = Number(args['text-scale'] ?? '1');
assert.ok(textScale === 1 || textScale === 2, '--text-scale must be 1 or 2');
const injectedCss = args['style-file'] ? await readFile(resolve(args['style-file']), 'utf8') : undefined;
assert.ok(widths.length > 0 && widths.length <= 5 && widths.every(width => Number.isSafeInteger(width) && width >= 320 && width <= 1440));
assert.equal(new Set(widths).size, widths.length, 'duplicate viewport widths are not useful');
const info = await snapshotInfo(root);
const before = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
const rows: any[] = [], cleanupErrors: string[] = [];
const knownPosterHosts = new Set(info.snapshot.performances.flatMap((item: any) => {
  try { return item.poster ? [new URL(item.poster).hostname] : []; } catch { return []; }
}));
const posterSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="#c7d9d4"/><text x="150" y="210" text-anchor="middle" fill="#254b43" font-size="24">LOCAL POSTER</text></svg>';
let fixture: Awaited<ReturnType<typeof startBrowserFixture>> | undefined, browser: Browser | undefined;
let phase = 'fixture-start', fatalError: string | undefined;
try {
  fixture = await startBrowserFixture(root);
  phase = 'browser-start';
  browser = await chromium.launch();
  for (const width of widths) {
    const row: any = { width, height: 812, passed: false, errors: [], unexpectedExternal: [] };
    rows.push(row);
    let context: BrowserContext | undefined;
    try {
      phase = `viewport-${width}`;
      context = await browser.newContext({ ...devices['Pixel 7'], viewport: { width, height: 812 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce', serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      page.on('pageerror', error => row.errors.push(error.message));
      await page.addInitScript('globalThis.__name = function(value) { return value; };');
      await page.addInitScript(({ from, to }) => localStorage.setItem('culture-desk.filters.v3', JSON.stringify({ cities: [], from, to, genre: '', q: '', status: '', price: '', age: '', source: '', limit: 30 })),
        { from: info.snapshot.coverage?.from ?? '2026-10-01', to: info.snapshot.coverage?.to ?? '2027-01-17' });
      const appUrl = fixture.ready.url;
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === appUrl) return route.continue();
        if (route.request().resourceType() === 'image' && knownPosterHosts.has(url.hostname)) return route.fulfill({ contentType: 'image/svg+xml', body: posterSvg });
        row.unexpectedExternal.push(`${url.origin}${url.pathname}`);
        return route.abort('blockedbyclient');
      });
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/performances');
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      const result = await (await response).json();
      await page.waitForFunction(({ count, title }) => document.querySelector('.results')?.getAttribute('aria-busy') === 'false'
        && document.querySelectorAll('.performance-grid .performance-card').length === count
        && document.querySelector('.performance-grid .card-body h3')?.textContent === title, { count: result.items.length, title: result.items[0]?.title });
      await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))); window.scrollTo(0, 0); });
      if (injectedCss) await page.addStyleTag({ content: injectedCss });
      if (textScale === 2) {
        row.textReflow = await page.evaluate(async () => {
          // Snapshot every original computed value before writing styles so inherited
          // descendants are doubled once, not compounded. This is a CSS text stress
          // of the rendered search page, not browser zoom or OS text scaling.
          const original = [...document.querySelectorAll('body, body *')].filter((element): element is HTMLElement => element instanceof HTMLElement && element.getClientRects().length > 0)
            .map(element => { const style = getComputedStyle(element); return { element, font: parseFloat(style.fontSize), line: parseFloat(style.lineHeight) }; });
          for (const { element, font, line } of original) {
            element.style.setProperty('font-size', `${font * 2}px`, 'important');
            if (Number.isFinite(line)) element.style.setProperty('line-height', `${line * 2}px`, 'important');
          }
          await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
          const ratios = original.map(({ element, font }) => parseFloat(getComputedStyle(element).fontSize) / font);
          return { mechanism: 'Rendered HTMLElement computed font-size and numeric line-height multiplied by2; original values captured before mutation. Existing fixed element dimensions remain for reflow stress. Later-mounted modal text is outside scope.',
            elements: original.length, minimumComputedFontRatio: Math.min(...ratios), maximumComputedFontRatio: Math.max(...ratios) };
        });
        assert.ok(Math.abs(row.textReflow.minimumComputedFontRatio - 2) < .001);
        assert.ok(Math.abs(row.textReflow.maximumComputedFontRatio - 2) < .001);
      }
      row.result = { total: result.total, displayed: result.items.length, firstId: result.items[0]?.id, firstTitle: result.items[0]?.title, partial: result.partial, pendingDetails: result.pendingDetails };
      row.layout = await page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth, viewportHeight = document.documentElement.clientHeight;
        const rect = (element: Element | null) => {
          if (!element) return null;
          const box = element.getBoundingClientRect(), style = getComputedStyle(element);
          return { x: box.x, top: box.top, bottom: box.bottom, width: box.width, height: box.height, display: style.display,
            fontSize: style.fontSize, lineHeight: style.lineHeight, marginTop: style.marginTop, marginBottom: style.marginBottom, gap: style.gap };
        };
        const selectors = { navigation: '.sidebar', pageHeader: '.explore-head', heading: '.explore-head h1', subtitle: '.view-sub', mapShortcut: '.explore-head-actions', overview: '.search-overview',
          filterBar: '.explore-filter-bar', region: '.explore-region-bar', regionHelp: '.region-search-help', toolbar: '.search-toolbar', resultsHeader: '.results-head', resultsActions: '.results-actions',
          coverage: '.coverage-note', pending: '.inline-note', firstCard: '.performance-grid .performance-card', firstTitle: '.performance-grid .card-body h3', firstPoster: '.performance-grid .card-art' };
        const bounds = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, rect(document.querySelector(selector))]));
        const first = document.querySelector('.performance-grid .performance-card')!.getBoundingClientRect();
        const title = document.querySelector('.performance-grid .card-body h3')!.getBoundingClientRect();
        const visibleHeight = Math.max(0, Math.min(viewportHeight, first.bottom) - Math.max(0, first.top));
        const textOverflow: any[] = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.trim() || !node.parentElement?.getClientRects().length) continue;
          const range = document.createRange(); range.selectNodeContents(node); const box = range.getBoundingClientRect();
          if (box.right <= viewportWidth + 1) continue;
          const ancestors = []; let parent: Element | null = node.parentElement;
          while (parent && parent !== document.body) { const style = getComputedStyle(parent); ancestors.push({ tag: parent.tagName, className: parent.className, overflowX: style.overflowX }); parent = parent.parentElement; }
          if (!ancestors.some(ancestor => ancestor.overflowX === 'hidden' || ancestor.overflowX === 'clip' || ancestor.overflowX === 'auto' || ancestor.overflowX === 'scroll')) textOverflow.push({ text: node.textContent.trim().slice(0, 100), right: box.right, ancestors: ancestors.slice(0, 5) });
        }
        return { viewport: { width: viewportWidth, height: viewportHeight, innerWidth, innerHeight, devicePixelRatio }, scrollY, scrollWidth: document.documentElement.scrollWidth,
          bounds, textOverflow, firstCardVisibleHeight: visibleHeight, firstCardVisibleAreaRatio: visibleHeight / first.height,
          scrollForFirstCardEdge: Math.max(0, first.top - viewportHeight), scrollForFullFirstTitle: Math.max(0, title.bottom - viewportHeight),
          controls: [...document.querySelectorAll('.region-trigger, .quick-search input, .quick-period input, .filter-toggle, .view-switch button, .results-actions > .button, .pagination .icon-button')]
            .filter(element => element.getClientRects().length > 0).map(element => ({ label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '', ...rect(element) })),
          clippedText: [...document.querySelectorAll('.explore-head h1, .view-sub, .region-trigger, .selected-regions, .quick-search input, .quick-period input, .filter-toggle, .result-counts, .view-switch button, .results-actions > .button, .performance-grid .card-body h3')]
            .filter(element => element.getClientRects().length > 0 && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1))
            .map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.trim(), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight })),
          overflowEdges: [...document.querySelectorAll('body *')].filter(element => element.getClientRects().length > 0 && element.getBoundingClientRect().right > viewportWidth + 1)
            .map(element => ({ tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', right: element.getBoundingClientRect().right, text: element.textContent?.trim().slice(0, 100) })).slice(0, 40),
          navigationText: [...document.querySelectorAll('.nav a, .region-trigger')].map(element => {
            const range = document.createRange(); range.selectNodeContents(element); const text = range.getBoundingClientRect(); const style = getComputedStyle(element);
            return { label: element.textContent?.trim(), element: rect(element), text: { left: text.left, right: text.right, width: text.width },
              whiteSpace: style.whiteSpace, overflow: style.overflow, flex: style.flex, minWidth: style.minWidth, parent: rect(element.parentElement) };
          }),
          titleFlow: [...document.querySelectorAll('.performance-grid .card-body')].slice(0, 3).map(element => ({ title: rect(element.querySelector('h3')), button: rect(element.querySelector('h3 button')), facts: rect(element.querySelector('.card-facts')) })) };
      });
      assert.equal(row.layout.scrollY, 0);
      if (textScale === 1) assert.ok(row.layout.scrollWidth <= width + 1, 'no horizontal viewport overflow');
      const prefix = resolve(dirname(args.out), `${basename(args.out, '.json')}-${width}`);
      await page.screenshot({ path: `${prefix}-overview.png` });
      await page.locator('.explore-filter-bar').screenshot({ path: `${prefix}-filters.png` });
      await page.locator('.performance-grid .performance-card').first().scrollIntoViewIfNeeded();
      row.firstResultScrollY = await page.evaluate(() => scrollY);
      await page.screenshot({ path: `${prefix}-first-result.png` });
      if (textScale === 1) {
      await page.getByRole('button', { name: /^지역 선택/ }).first().click();
      const dialog = page.getByRole('dialog', { name: '전국 지역 선택' });
      await dialog.waitFor({ state: 'visible' });
      row.regionExplanation = await dialog.locator('.region-modal-sub').textContent();
      assert.ok(row.regionExplanation.includes('선택하지 않거나 모두 체크하면 전국을 조회합니다.'));
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('region-trigger')), true);
      }
      assert.deepEqual(row.errors, []); assert.deepEqual(row.unexpectedExternal, []);
      row.passed = true;
    } catch (error) { row.error = String(error); }
    finally { try { await context?.close(); } catch (error) { cleanupErrors.push(String(error)); } }
    await saveJson(args.out, { status: 'partial', phase, before, rows, cleanupErrors });
  }
} catch (error) { fatalError = String(error); }
finally {
  try { await browser?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  finally { try { await fixture?.stop(); } catch (error) { cleanupErrors.push(String(error)); } }
}
const after = { source: await sourceFingerprint(root, ['web', 'shared']), client: await clientFingerprint(root) };
const report = { version: 1, measuredAt: new Date().toISOString(), textScale, scope: 'Functional mobile layout only: real snapshot and full coverage filters; local synthetic posters. CSS viewport height812. Pixel7 deviceScaleFactor is raster density only. Optional text-scale2 is a labeled computed CSS font/line-height reflow stress, not real browser/OS text scaling, physical device testing or WCAG certification. Stress captures existing overflow instead of using it as a normal-layout pass. No timing acceptance.',
  root, ...(injectedCss ? { injectedCss: { path: resolve(args['style-file']), hash: sha256(injectedCss), content: injectedCss } } : {}), snapshot: { count: info.count, hash: info.hash }, before, after, sourceStable: before.source.hash === after.source.hash, clientStable: before.client.hash === after.client.hash, rows, fatalError, phase, cleanupErrors };
await saveJson(args.out, report);
console.log(JSON.stringify({ out: args.out, fatalError, sourceStable: report.sourceStable, clientStable: report.clientStable, cleanupErrors, rows: rows.map(row => ({ width: row.width, passed: row.passed, error: row.error, firstCardTop: row.layout?.bounds.firstCard?.top, firstCardVisibleHeight: row.layout?.firstCardVisibleHeight, scrollForFullFirstTitle: row.layout?.scrollForFullFirstTitle })) }, null, 2));
if (fatalError || cleanupErrors.length || !report.sourceStable || !report.clientStable || rows.some(row => !row.passed)) process.exitCode = 1;
