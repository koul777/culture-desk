import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Page, Route } from '@playwright/test';
import { deadline, rasterMetadata, routeLedger } from '../scripts/performance/poster-runtime.js';

test('poster corpus rejects SVG, unknown signatures and MIME mismatches', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(rasterMetadata(png, 'image/png; charset=binary').format, 'png');
  assert.equal(rasterMetadata(Buffer.from([255, 216, 255, 224]), 'image/jpeg').format, 'jpeg');
  assert.throws(() => rasterMetadata(png, 'image/jpeg'), /MIME mismatch/);
  assert.throws(() => rasterMetadata(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'), /SVG/);
  assert.throws(() => rasterMetadata(png, 'image/svg+xml'), /SVG/);
  assert.throws(() => rasterMetadata(Buffer.from('ordinary text'), 'image/png'), /Unsupported/);
  assert.throws(() => rasterMetadata(Buffer.from('xxxxftypavif'), 'image/avif'), /Unsupported/);
  const avif = Buffer.alloc(20); avif.writeUInt32BE(20); avif.write('ftyp', 4); avif.write('avif', 8); avif.write('mif1', 16);
  assert.equal(rasterMetadata(avif, 'image/avif').format, 'avif');
});

test('poster deadline rejects a stalled operation independently', async () => {
  await assert.rejects(deadline(new Promise<never>(() => {}), 'stalled', 10), /stalled exceeded 10 ms/);
  assert.equal(await deadline(Promise.resolve(3), 'resolved', 100), 3);
});

test('route ledger distinguishes fulfilled bytes, explicit close cancellation and arbitrary errors', async () => {
  const page = new EventEmitter(), ledger = routeLedger(page as unknown as Page);
  const request = { url: () => 'https://example.test/poster.jpg', resourceType: () => 'image' };
  const route = { request: () => request } as unknown as Route;
  page.emit('request', request);
  await ledger.track(route, 'saved-raster', async () => {}, { hash: 'saved-hash', bytes: 12 });
  page.emit('requestfinished', request);
  ledger.beginClose();
  await ledger.track(route, 'saved-raster', async () => { throw new Error('Target page, context or browser has been closed'); });
  await ledger.track(route, 'local', async () => { throw new Error('Unexpected network failure'); });
  const pendingRequest = { ...request, url: () => 'https://example.test/pending.jpg' };
  page.emit('request', pendingRequest);
  const result = await ledger.settle(true);
  assert.equal(ledger.routes[0].hash, 'saved-hash'); assert.equal(ledger.routes[0].state, 'settled');
  assert.equal(result.pendingRoutes, 0); assert.equal(result.pendingRequests, 0);
  assert.equal(result.cancelledRoutes, 1); assert.equal(result.requestsCancelledByContext, 1);
  assert.equal(result.errors.length, 1); assert.match(result.errors[0].error!, /Unexpected network failure/);
  assert.equal(ledger.requests[0].terminal, 'finished');
});
