import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { markAfterPaint, markPerformance, measurePerformance } from '../web/lib/performance.js';

function environment(t: TestContext, enabled: boolean) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __CULTURE_PERFORMANCE__: enabled,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callbacks.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: (id: number) => { cancelled.push(id); callbacks.delete(id); },
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original); else Reflect.deleteProperty(globalThis, 'window');
    for (const entry of performance.getEntries()) {
      if (!entry.name.startsWith('culture:TEST')) continue;
      if (entry.entryType === 'mark') performance.clearMarks(entry.name);
      if (entry.entryType === 'measure') performance.clearMeasures(entry.name);
    }
  });
  const paint = () => {
    const pending = [...callbacks];
    for (const [id, callback] of pending) { callbacks.delete(id); callback(performance.now()); }
  };
  return { callbacks, cancelled, paint };
}

test('normal browsing creates neither timing entries nor animation-frame work', t => {
  const env = environment(t, false);
  markPerformance('TEST-request', { requestId: 1 });
  const cancel = markAfterPaint('TEST-ready', { requestId: 1 });
  assert.equal(measurePerformance('TEST-work', {}, () => 42), 42);
  cancel();
  assert.equal(env.callbacks.size, 0);
  assert.deepEqual(performance.getEntries().filter(entry => entry.name.startsWith('culture:TEST')), []);
});

test('paint readiness carries the response identity only after two frames', t => {
  const env = environment(t, true);
  const detail = { requestId: 7, filterKey: 'TEST filters', dataSource: 'map', count: 5649 };
  markAfterPaint('TEST-ready', detail);
  env.paint();
  assert.equal(performance.getEntriesByName('culture:TEST-ready').length, 0);
  env.paint();
  const entries = performance.getEntriesByName('culture:TEST-ready') as PerformanceMark[];
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].detail, detail);
});

test('unmount or a superseding zoom cancels pending readiness before either frame', t => {
  const env = environment(t, true);
  const first = markAfterPaint('TEST-obsolete', { requestId: 1 });
  first(); env.paint();
  const second = markAfterPaint('TEST-obsolete', { requestId: 2 });
  env.paint(); second(); env.paint();
  assert.equal(performance.getEntriesByName('culture:TEST-obsolete').length, 0);
  assert.equal(env.callbacks.size, 0);
  assert.equal(env.cancelled.length, 2);
});

test('profiling does not swallow rendering failures or alter returned values', t => {
  environment(t, true);
  const reason = new Error('TEST rendering failure');
  assert.throws(() => measurePerformance('TEST-failed-work', { count: 1 }, () => { throw reason; }), error => error === reason);
  assert.equal(performance.getEntriesByName('culture:TEST-failed-work').length, 1);
  const expected = { value: 'TEST result' };
  assert.equal(measurePerformance('TEST-success-work', {}, () => expected), expected);
});
