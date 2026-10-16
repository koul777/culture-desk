import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextRefreshAt, refreshPresentation, type AutomaticRefresh } from '../web/lib/automatic-refresh.js';

const base: AutomaticRefresh = {
  enabled: true, status: 'complete', day: '2026-10-16', from: '2026-10-01', to: '2027-01-16',
  lastSuccessAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', counts: null, error: null,
  schedule: { timezone: 'Asia/Seoul', primary: '04:17', retries: ['06:47', '12:47', '20:47'] },
};

test('complete status still warns when last nationwide success is older than 36 hours', () => {
  assert.equal(refreshPresentation(base, Date.parse('2026-10-16T12:00:01Z')).delayed, true);
  assert.equal(refreshPresentation(base, Date.parse('2026-10-16T12:00:00Z')).delayed, false);
  assert.equal(refreshPresentation({ ...base, enabled: false }, Date.parse('2026-10-17T00:00:00Z')).delayed, false);
  assert.equal(refreshPresentation({ ...base, lastSuccessAt: null }).delayed, false);
});

test('recovery reservation uses Korea time, advances across midnight, and completed jobs wait for daily primary', () => {
  assert.equal(nextRefreshAt({ ...base, status: 'retry_wait' }, Date.parse('2026-10-16T10:00:00+09:00')), '2026-10-16T03:47:00.000Z');
  assert.equal(nextRefreshAt({ ...base, status: 'failed' }, Date.parse('2026-10-16T21:00:00+09:00')), '2026-10-16T19:17:00.000Z');
  assert.equal(nextRefreshAt(base, Date.parse('2026-10-16T10:00:00+09:00')), '2026-10-16T19:17:00.000Z');
  assert.equal(nextRefreshAt({ ...base, status: 'unavailable' }), null);
});
