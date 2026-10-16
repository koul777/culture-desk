import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readVWorldMessage, vworldAvailable, vworldFrameUrl } from '../web/lib/vworld-client.js';

test('only the current same-origin frame and exact random channel can update viewer state', () => {
  const frame = {} as Window;
  const other = {} as Window;
  const origin = 'https://culture.example';
  const data = { type: 'culture-vworld', channel: 'one-attempt', status: 'ready' };
  const event = { origin, source: frame, data };
  assert.equal(readVWorldMessage(event, frame, origin, 'one-attempt')?.status, 'ready');
  assert.equal(readVWorldMessage({ ...event, source: other }, frame, origin, 'one-attempt'), null);
  assert.equal(readVWorldMessage({ ...event, origin: 'https://other.example' }, frame, origin, 'one-attempt'), null);
  assert.equal(readVWorldMessage(event, frame, origin, 'next-attempt'), null);
  assert.equal(readVWorldMessage(event, null, origin, 'one-attempt'), null);
  for (const bad of [null, {}, { ...data, type: 'other' }, { ...data, status: 'building-verified' }]) {
    assert.equal(readVWorldMessage({ ...event, data: bad }, frame, origin, 'one-attempt'), null);
  }
});

test('frame URL keeps coordinates, Korean labels and channels as encoded same-origin parameters', () => {
  const url = new URL(vworldFrameUrl(37.34, 127.92, '공연장 & 무대 #1', 'channel-value'), 'https://culture.example');
  assert.equal(url.origin, 'https://culture.example');
  assert.equal(url.pathname, '/api/maps/vworld/frame');
  assert.equal(url.searchParams.get('label'), '공연장 & 무대 #1');
  assert.equal(url.searchParams.get('lat'), '37.34');
  assert.equal(url.searchParams.get('lon'), '127.92');
  assert.equal(url.searchParams.get('channel'), 'channel-value');
});

test('configuration requires explicit availability and otherwise selects the existing viewer', async t => {
  let payload: unknown = { available: true };
  let ok = true;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload), { status: ok ? 200 : 503 }));
  const signal = new AbortController().signal;
  assert.equal(await vworldAvailable(signal), true);
  for (payload of [{ available: false }, { available: 'true' }, {}, null]) assert.equal(await vworldAvailable(signal), false);
  ok = false; payload = { available: true };
  assert.equal(await vworldAvailable(signal), false);
});

test('configuration timeout aborts the request and close cancels it without loading a viewer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', (_path: string, options: RequestInit) => {
    const signal = options.signal!; signals.push(signal);
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const parent = new AbortController();
  const timeout = vworldAvailable(parent.signal);
  t.mock.timers.tick(6000);
  assert.equal(await timeout, false);
  assert.equal(signals[0].aborted, true);
  const cancelled = vworldAvailable(parent.signal);
  parent.abort();
  assert.equal(await cancelled, false);
  assert.equal(signals[1].aborted, true);
  assert.equal(await vworldAvailable(parent.signal), false);
  assert.equal(signals.length, 2);
});
