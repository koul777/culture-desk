import assert from 'node:assert/strict';
import test from 'node:test';
import { locateScrollDelta, locateVisibleBounds, scheduleLocatedRowScroll } from '../web/lib/map-locate-scroll.js';

test('external locate scroll is zero for an already visible row and minimal above or below', () => {
  const viewport = { top: 100, bottom: 812 };
  assert.equal(locateScrollDelta({ top: 200, bottom: 350 }, viewport), 0);
  assert.equal(locateScrollDelta({ top: 70, bottom: 220 }, viewport), -42);
  assert.equal(locateScrollDelta({ top: 750, bottom: 900 }, viewport), 100);
  assert.equal(locateScrollDelta({ top: -500, bottom: -350 }, viewport), -612);
});

test('a row taller than the available viewport reveals its start below the fixed top bar', () => {
  assert.equal(locateScrollDelta({ top: 180, bottom: 680 }, { top: 120, bottom: 400 }), 48);
});

test('visible bounds account for visual viewport offset and only overlapping pinned headers', () => {
  const row = { left: 200, right: 350 }, viewport = { offsetTop: 80, height: 420 };
  const header = { top: 80, bottom: 160, left: 0, right: 375, position: 'sticky' };
  assert.deepEqual(locateVisibleBounds(row, viewport), { top: 80, bottom: 500 });
  assert.deepEqual(locateVisibleBounds(row, viewport, header), { top: 160, bottom: 500 });
  assert.deepEqual(locateVisibleBounds(row, viewport, { ...header, right: 180, bottom: 1000 }), { top: 80, bottom: 500 }, 'desktop side navigation does not obscure the row');
  assert.deepEqual(locateVisibleBounds(row, viewport, { ...header, position: 'static' }), { top: 80, bottom: 500 });
  assert.deepEqual(locateVisibleBounds(row, viewport, { ...header, top: 100 }), { top: 80, bottom: 500 }, 'a header not yet pinned is not a top obstruction');
});

test('pending row scroll cancels cleanly and a settled or bounded request scrolls at most once', () => {
  const frames = new Map<number, FrameRequestCallback>(), scrolls: ScrollToOptions[] = [];
  const listeners = new Map<string, Set<EventListener>>();
  const listenerCount = () => [...listeners.values()].reduce((sum, values) => sum + values.size, 0);
  const emit = (type: string, key?: string) => {
    const event = new Event(type); if (key) Object.defineProperty(event, 'key', { value: key });
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };
  let sequence = 0, done = 0, top = -100;
  const target = { isConnected: true, getBoundingClientRect: () => ({ top, bottom: top + 100, left: 20, right: 220 }) } as HTMLElement;
  const documentStub = { activeElement: target as unknown, querySelector: () => null };
  const replacements = {
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    document: documentStub,
    window: { innerHeight: 812, scrollBy: (options: ScrollToOptions) => { scrolls.push(options); },
      addEventListener: (type: string, listener: EventListener) => { const group = listeners.get(type) ?? new Set<EventListener>(); group.add(listener); listeners.set(type, group); },
      removeEventListener: (type: string, listener: EventListener) => { listeners.get(type)?.delete(listener); } },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const step = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(0)); };
  try {
    for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true });
    const cancel = scheduleLocatedRowScroll(target, () => { done++; });
    step(); cancel(); step(); assert.equal(scrolls.length, 0); assert.equal(frames.size, 0); assert.equal(listenerCount(), 0);
    scheduleLocatedRowScroll(target, () => { done++; }); documentStub.activeElement = null; step();
    assert.equal(scrolls.length, 0); assert.equal(frames.size, 0);
    documentStub.activeElement = target;
    scheduleLocatedRowScroll(target, () => { done++; }); (target as { isConnected: boolean }).isConnected = false; step();
    assert.equal(scrolls.length, 0); assert.equal(frames.size, 0);
    (target as { isConnected: boolean }).isConnected = true;
    scheduleLocatedRowScroll(target, () => { done++; }); step(); step(); step(); step();
    assert.deepEqual(scrolls, [{ top: -112, behavior: 'instant' }]); assert.equal(frames.size, 0);
    scheduleLocatedRowScroll(target, () => { done++; });
    for (let index = 0; index < 50; index++) { top--; step(); }
    assert.equal(scrolls.length, 2, 'continued auto-pan has a bounded wait and one correction');
    assert.equal(frames.size, 0); assert.equal(done, 4); assert.equal(listenerCount(), 0);
    for (const type of ['wheel', 'touchstart', 'pointerdown']) {
      scheduleLocatedRowScroll(target, () => { done++; }); step(); emit(type); step();
      assert.equal(scrolls.length, 2, `${type} cancels before a correction`);
      assert.equal(frames.size, 0); assert.equal(listenerCount(), 0);
    }
    scheduleLocatedRowScroll(target, () => { done++; }); emit('keydown', 'a');
    assert.equal(frames.size, 1, 'a non-scroll key does not by itself cancel');
    emit('keydown', 'PageDown'); step();
    assert.equal(scrolls.length, 2); assert.equal(frames.size, 0); assert.equal(listenerCount(), 0); assert.equal(done, 8);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
