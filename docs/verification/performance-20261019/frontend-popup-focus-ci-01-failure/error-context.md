# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: popup.spec.ts >> new focus intent cancels queued popup row focus while layout updates preserve it
- Location: tests\e2e\popup.spec.ts:139:1

# Error details

```
Error: expect(locator).toBeFocused() failed

Locator:  locator('.leaflet-popup-close-button')
Expected: focused
Received: inactive
Timeout:  7000ms

Call log:
  - Expect "toBeFocused" locator('.leaflet-popup-close-button') with timeout 7000ms
  - waiting for locator('.leaflet-popup-close-button')
    17 × locator resolved to <a role="button" href="#close" aria-label="Close popup" class="leaflet-popup-close-button">…</a>
       - unexpected value "inactive"

```

```yaml
- button "Close popup"
```

# Test source

```ts
  73  | 
  74  |   const locate = page.locator('.map-result-list .card-locate').last();
  75  |   const targetRow = popup.locator(`[data-performance-id="${target.id}"]`);
  76  |   const visibleFraction = () => targetRow.evaluate(element => {
  77  |     const row = element.getBoundingClientRect(), scroll = element.closest('.leaflet-popup-content')!.getBoundingClientRect();
  78  |     let top = window.visualViewport?.offsetTop ?? 0;
  79  |     const bottom = top + (window.visualViewport?.height ?? window.innerHeight);
  80  |     const header = document.querySelector<HTMLElement>('.sidebar');
  81  |     if (header) {
  82  |       const bounds = header.getBoundingClientRect(), position = getComputedStyle(header).position;
  83  |       if (['fixed', 'sticky'].includes(position) && bounds.top <= top + 1 && bounds.left < row.right && bounds.right > row.left) top = Math.max(top, bounds.bottom);
  84  |     }
  85  |     return Math.max(0, Math.min(row.bottom, scroll.bottom, bottom) - Math.max(row.top, scroll.top, top)) / row.height;
  86  |   });
  87  |   await locate.click(); await expect(targetRow).toBeFocused();
  88  |   await expect.poll(visibleFraction).toBeGreaterThan(.99);
  89  |   await expect(search).toHaveValue(''); await expect(popup.locator('.map-popup-page')).toHaveText('2 / 2');
  90  |   // A fresh local query hides this already-selected ID; same-ID locate must still work.
  91  |   await search.fill('없는 공연장 TEST xyz'); await expect(shows).toHaveCount(0);
  92  |   await locate.click(); await expect(targetRow).toBeFocused();
  93  |   await expect.poll(visibleFraction).toBeGreaterThan(.99);
  94  |   await expect(search).toHaveValue(''); await expect(popup.locator('.map-popup-page')).toHaveText('2 / 2');
  95  |   expect(requests).toEqual(initialRequests);
  96  |   await testInfo.attach('popup-local-state.json', { body: JSON.stringify({ orderedIds: ordered.map(item => item.id), targetId: target.id, preserved, requests }, null, 2), contentType: 'application/json' });
  97  | });
  98  | 
  99  | test('cached popup state survives visiting another marker and zooming within venue view', async ({ page }) => {
  100 |   // This desktop retention flow uses visible map zoom controls. The separate
  101 |   // narrow test above protects mobile external-locate viewport visibility.
  102 |   await page.setViewportSize({ width: 1440, height: 1000 });
  103 |   let ordered: MapPerformance[] = [];
  104 |   await page.route('**/api/map?**', async route => {
  105 |     const response = await route.fetch(), body = await response.json();
  106 |     ordered = body.items;
  107 |     const items = ordered.map((item, index) => ({ ...item, latitude: 34.76 + (index === 35 ? .0015 : 0), longitude: 127.66 + (index === 35 ? .0015 : 0), locationPrecision: 'venue' }));
  108 |     await route.fulfill({ response, json: { ...body, items } });
  109 |   });
  110 |   await openPublished(page);
  111 |   await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  112 |   await expect(page.locator('.map-scope-note')).toContainText('검색 결과 36건');
  113 |   await page.locator('.map-result-list .card-locate').first().click();
  114 |   const marker = page.locator('.venue-map-marker[data-performance-count="35"]'), sibling = page.locator('.venue-map-marker[data-performance-count="1"]');
  115 |   await expect(marker).toHaveCount(1); await expect(sibling).toHaveCount(1);
  116 |   const popup = page.locator('.map-popup'), search = popup.locator('input');
  117 |   const next = popup.getByRole('button', { name: '이 위치의 공연 다음 페이지', exact: true });
  118 |   const state = () => popup.evaluate(element => ({ query: element.querySelector<HTMLInputElement>('input')!.value,
  119 |     page: element.querySelector('.map-popup-page')!.textContent,
  120 |     ids: [...element.querySelectorAll<HTMLElement>('.map-popup-show')].map(row => row.dataset.performanceId) }));
  121 |   for (const local of ['query', 'page2']) for (const method of ['pointer', 'keyboard']) {
  122 |     await search.fill('reset-local'); await search.fill('');
  123 |     if (local === 'query') await search.fill(ordered[34].title); else await next.click();
  124 |     const expected = await state();
  125 |     await search.focus(); await page.keyboard.press('Escape'); await sibling.click();
  126 |     await popup.locator('.map-popup-show').first().focus(); await page.keyboard.press('Escape');
  127 |     if (method === 'pointer') await marker.click(); else { await marker.focus(); await page.keyboard.press('Enter'); }
  128 |     await expect.poll(state).toEqual(expected);
  129 |   }
  130 |   await search.fill('reset-local'); await search.fill(''); await next.click();
  131 |   const expected = await state(), inputNode = await search.elementHandle(), markerNode = await marker.elementHandle();
  132 |   await page.locator('.leaflet-control-zoom-in').click();
  133 |   await expect(popup).toBeVisible(); await expect.poll(state).toEqual(expected);
  134 |   expect(await inputNode!.evaluate(element => element.isConnected && element === document.querySelector('.map-popup-search input'))).toBe(true);
  135 |   expect(await markerNode!.evaluate(element => element.isConnected && element === document.querySelector('.venue-map-marker[data-performance-count="35"]'))).toBe(true);
  136 |   await inputNode?.dispose(); await markerNode?.dispose();
  137 | });
  138 | 
  139 | test('new focus intent cancels queued popup row focus while layout updates preserve it', async ({ page }, testInfo) => {
  140 |   await page.setViewportSize({ width: 1440, height: 1000 });
  141 |   await page.route('**/api/map?**', async route => {
  142 |     const response = await route.fetch(), body = await response.json();
  143 |     await route.fulfill({ response, json: { ...body, items: body.items.map((item: MapPerformance) => ({ ...item, latitude: 34.76, longitude: 127.66, locationPrecision: 'venue' })) } });
  144 |   });
  145 |   await openPublished(page);
  146 |   await page.getByRole('button', { name: '지도 + 목록', exact: true }).click();
  147 |   const marker = page.locator('.venue-map-marker[data-performance-count="36"]');
  148 |   await marker.focus(); await page.keyboard.press('Enter');
  149 |   const popup = page.locator('.map-popup'), search = popup.locator('input'), rows = popup.locator('.map-popup-show');
  150 |   await expect(rows.first()).toBeFocused();
  151 |   const next = popup.getByRole('button', { name: '이 위치의 공연 다음 페이지', exact: true });
  152 |   const externalSearch = page.getByRole('searchbox', { name: '공연명·공연장 검색', exact: true });
  153 |   const results: unknown[] = [];
  154 |   for (const intent of ['tab', 'external-search', 'layout']) {
  155 |     await search.fill('reset-local'); await search.fill(''); await next.focus();
  156 |     try {
  157 |       const captured = await page.evaluate(() => {
  158 |         const nativeFrame = window.requestAnimationFrame, nativeCancel = window.cancelAnimationFrame;
  159 |         const frames = new Map<number, FrameRequestCallback>(), held = new Set<number>(); let sequence = 1_000_000_000;
  160 |         const cleanup = () => { frames.clear(); window.requestAnimationFrame = nativeFrame; window.cancelAnimationFrame = nativeCancel; delete (window as any).__popupFocusTest; };
  161 |         (window as any).__popupFocusTest = { cleanup, release: () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(performance.now())); return batch.length; } };
  162 |         window.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); held.add(id); return id; };
  163 |         window.cancelAnimationFrame = id => { if (held.has(id)) frames.delete(id); else nativeCancel.call(window, id); };
  164 |         // Delay only frames scheduled synchronously by this one button activation.
  165 |         // Restore normal RAF before genuine Tab/click/resize input begins.
  166 |         try { document.querySelector<HTMLButtonElement>('.map-popup-pagination button:last-child')!.click(); }
  167 |         finally { window.requestAnimationFrame = nativeFrame; }
  168 |         return frames.size;
  169 |       });
  170 |       expect(captured, 'exactly the controller focus frame is held').toBe(1);
  171 |       await expect(popup.locator('.map-popup-page')).toHaveText('2 / 2');
  172 |       if (intent === 'tab') {
> 173 |         await page.keyboard.press('Tab'); await expect(page.locator('.leaflet-popup-close-button')).toBeFocused();
      |                                                                                                     ^ Error: expect(locator).toBeFocused() failed
  174 |       } else if (intent === 'external-search') {
  175 |         await externalSearch.click(); await expect(externalSearch).toBeFocused();
  176 |       } else {
  177 |         await page.setViewportSize({ width: 1441, height: 1000 });
  178 |         await page.setViewportSize({ width: 1440, height: 1000 });
  179 |         await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  180 |         await expect(next).toBeFocused();
  181 |       }
  182 |       const released = await page.evaluate(() => (window as any).__popupFocusTest.release());
  183 |       expect(released).toBe(intent === 'layout' ? 1 : 0);
  184 |       if (intent === 'tab') await expect(page.locator('.leaflet-popup-close-button')).toBeFocused();
  185 |       else if (intent === 'external-search') await expect(externalSearch).toBeFocused();
  186 |       else await expect(rows.first()).toBeFocused();
  187 |       results.push({ intent, captured, released });
  188 |     } finally { await page.evaluate(() => (window as any).__popupFocusTest?.cleanup()); }
  189 |   }
  190 |   await search.fill('reset-local'); await search.fill(''); await next.click();
  191 |   await expect(rows.first()).toBeFocused();
  192 |   await testInfo.attach('popup-focus-order.json', { body: JSON.stringify({ results, ordinaryPagerFocus: true }, null, 2), contentType: 'application/json' });
  193 | });
  194 | 
```