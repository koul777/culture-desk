import assert from 'node:assert/strict';
import test from 'node:test';
import { filterVenuePopupItems, revealVenuePopupItem, venuePopupPage, venuePopupSummary } from '../web/lib/map-popup-model.js';

const items = Array.from({ length: 210 }, (_, index) => ({ id: 5000 + index, title: index === 209 ? 'White Rabbit 마지막 공연' : `공연 ${index + 1}`, venue: index % 3 ? '예술의전당 [서울] (콘서트홀)' : '예술의전당 [서울] (자유소극장)' }));

test('paging preserves all210 ids and original order exactly, including the short final page', () => {
  const gathered = Array.from({ length: 11 }, (_, index) => venuePopupPage(items, '', index + 1).items).flat();
  assert.deepEqual(gathered.map(item => item.id), items.map(item => item.id));
  assert.equal(new Set(gathered).size, 210);
  assert.deepEqual(venuePopupPage(items, '', 99), venuePopupPage(items, '', 11));
  assert.equal(venuePopupPage(items, '', 11).items.length, 10);
  assert.equal(venuePopupPage(items, '', 0).page, 1);
});

test('venue search keeps exact original strings and input ordering, including duplicate titles', () => {
  const original = [{ id: 1, title: '같은 공연', venue: '예술의전당 콘서트홀' }, { id: 2, title: '같은 공연', venue: '예술의전당 [서울] (콘서트홀)' }, { id: 3, title: '다른 공연', venue: '자유소극장' }];
  assert.deepEqual(filterVenuePopupItems(original, ' 콘서트홀 ').map(item => item.id), [1, 2]);
  assert.deepEqual(filterVenuePopupItems(original, '같은 공연').map(item => item.id), [1, 2]);
  assert.deepEqual(venuePopupSummary(original).venueNames, original.map(item => item.venue));
  assert.equal(venuePopupSummary(original).mixedVenues, true);
  assert.equal(venuePopupSummary([original[0], { ...original[0], id: 4 }]).mixedVenues, false);
  assert.equal(filterVenuePopupItems(items, 'WHITE RABBIT')[0].id, 5209);
});

test('empty search has no rows and invalid or overshooting pages remain bounded', () => {
  const empty = venuePopupPage(items, '존재하지 않는 공연', 11);
  assert.deepEqual({ total: empty.total, page: empty.page, pages: empty.pages, from: empty.from, to: empty.to, rows: empty.items.length }, { total: 0, page: 1, pages: 1, from: 0, to: 0, rows: 0 });
  assert.equal(venuePopupPage(items, '', NaN).page, 1);
  assert.equal(venuePopupPage(items.slice(0, 2), '', 3).items.length, 2);
});

test('external focus reveals exact id, clearing only a query that hides it', () => {
  assert.deepEqual(revealVenuePopupItem(items, '', 5209), { query: '', page: 11 });
  assert.deepEqual(revealVenuePopupItem(items, 'White Rabbit', 5209), { query: 'White Rabbit', page: 1 });
  assert.deepEqual(revealVenuePopupItem(items, 'White Rabbit', 5000), { query: '', page: 1 });
  assert.equal(revealVenuePopupItem(items, 'White Rabbit', -1), null);
  assert.deepEqual(revealVenuePopupItem(items, '콘서트홀', 5208), { query: '콘서트홀', page: 7 });
});

test('optional or malformed snapshot venue values remain searchable by title without inventing venues', () => {
  const original = [
    { id: 1, title: '빈 공연장' }, { id: 2, title: '빈 공연장 null', venue: null },
    { id: 3, title: '빈 공연장 empty', venue: '' }, { id: 4, title: '빈 공연장 space', venue: '  ' },
    { id: 5, title: '빈 공연장 number', venue: 17 }, { id: 6, title: '알려진 공연', venue: '원문 (A홀)' },
  ];
  const copy = structuredClone(original);
  assert.deepEqual(filterVenuePopupItems(original, '없는 문자열'), []);
  assert.deepEqual(filterVenuePopupItems(original, '빈 공연장').map(item => item.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(filterVenuePopupItems(original, 'A홀').map(item => item.id), [6]);
  assert.deepEqual(venuePopupPage(original, '', 1).items.map(item => item.id), [1, 2, 3, 4, 5, 6]);
  const summary = venuePopupSummary(original);
  assert.deepEqual(summary.venueNames, ['원문 (A홀)']); assert.equal(summary.unknownVenueCount, 5);
  assert.equal(summary.hasSingleVenue, false); assert.equal(summary.mixedVenues, false);
  assert.equal(venuePopupSummary(original.slice(0, 5)).venueNames.length, 0);
  assert.equal(venuePopupSummary(original.slice(0, 5)).hasSingleVenue, false);
  assert.deepEqual(original, copy, 'search and presentation summaries never rewrite source rows');
  assert.equal(Object.hasOwn(original[0], 'venue'), false);
  assert.equal(original[1].venue, null);
});
