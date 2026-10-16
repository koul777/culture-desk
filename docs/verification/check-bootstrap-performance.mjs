import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const label = process.argv[2] || 'measurement';
const base = 'http://127.0.0.1:4317';
const [boot, map, search] = await Promise.all(['/api/bootstrap', '/api/map?from=2026-10-01&to=2027-01-16', '/api/performances?from=2026-10-01&to=2027-01-16'].map(async path => (await fetch(base + path)).json()));
boot.deployment = 'local'; boot.runs = [];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const counts = { bootstrap: 0, search: 0, map: 0, activeBootstrap: 0, maxConcurrent: 0, posts: 0 };
  let delay = 100;
  await page.route('**/api/**', async route => {
    const request = route.request();
    if (request.method() !== 'GET') { counts.posts++; return route.abort(); }
    const path = new URL(request.url()).pathname;
    if (path === '/api/bootstrap') {
      counts.bootstrap++; counts.activeBootstrap++; counts.maxConcurrent = Math.max(counts.maxConcurrent, counts.activeBootstrap);
      await new Promise(resolve => setTimeout(resolve, delay));
      await route.fulfill({ json: boot }); counts.activeBootstrap--; return;
    }
    if (path === '/api/performances') { counts.search++; return route.fulfill({ json: search }); }
    if (path === '/api/map') { counts.map++; return route.fulfill({ json: map }); }
    return route.abort();
  });
  await page.goto('http://127.0.0.1:5176/#map');
  await page.waitForFunction(() => document.querySelector('[data-performance-count]'));
  await page.waitForTimeout(250);
  const startup = { ...counts };
  await page.evaluate(() => {
    window.__mapChanges = 0;
    window.__marker = document.querySelector('[data-performance-count]');
    const pane = document.querySelector('.leaflet-marker-pane');
    window.__observer = new MutationObserver(records => { window.__mapChanges += records.reduce((sum, record) => sum + record.addedNodes.length + record.removedNodes.length, 0); });
    window.__observer.observe(pane, { childList: true });
  });
  delay = 400;
  counts.maxConcurrent = 0;
  await page.evaluate(() => { for (let i = 0; i < 10; i++) document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(900);
  const report = {
    label, method: 'Real local UI, frozen real GET payloads; ten visibility events while bootstrap delayed 400ms; all POST requests blocked',
    startup, burst: { bootstrap: counts.bootstrap - startup.bootstrap, maxConcurrent: counts.maxConcurrent, search: counts.search - startup.search, map: counts.map - startup.map },
    markers: await page.evaluate(() => ({ sameNode: window.__marker === document.querySelector('[data-performance-count]'), mutations: window.__mapChanges, sum: [...document.querySelectorAll('[data-performance-count]')].reduce((n, node) => n + Number(node.dataset.performanceCount), 0) })), posts: counts.posts,
  };
  assert.equal(counts.posts, 0);
  await writeFile(`docs/verification/bootstrap-performance-${label}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
