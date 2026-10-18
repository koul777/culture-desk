import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { Store } from '../server/store.js';
import { exportWorkbook } from '../server/export.js';
import type { City, PerformanceInput, SearchFilters } from '../shared/types.js';

test('export captures caller filters, selected IDs and all evidence before yielding or closing the Store', async t => {
  const city: City = { id: 'test-export-city', name: 'TEST city', sido: 'TEST province', sigungu: 'TEST district',
    kopisSido: '99', kopisSigungu: '9999', aliases: [] };
  const other: City = { ...city, id: 'test-export-other', sigungu: 'TEST other district' };
  const store = new Store(':memory:', [city, other]);
  let closed = false;
  t.after(() => { if (!closed) store.close(); });
  const row: PerformanceInput = { source: 'kopis', sourceId: 'TEST_EXPORT_CAPTURE', cityId: city.id,
    title: 'TEST original title', venue: 'TEST venue', startDate: '2026-10-01', endDate: '2026-10-31',
    genre: '음악', sourceGenre: '', address: '', poster: '', sourceUrl: '', price: '', priceType: 'unknown',
    age: '', runtime: '', cast: '', producer: '', organizer: '', contact: '', schedule: '', description: '',
    status: '', detailState: 'complete', classification: 'performance', reviewReason: '', raw: null };
  const id = store.upsert(row);
  const otherId = store.upsert({ ...row, source: 'culture', sourceId: 'TEST_EXPORT_OTHER', cityId: other.id,
    title: 'TEST other title', startDate: '2026-11-01', endDate: '2026-11-30' });
  store.bookmark(id, true, 'TEST original note');
  const run = store.createRun('kopis', city.id, '2026-10-01', '2026-10-31');
  store.setRunState(run, 'complete');
  const otherRun = store.createRun('culture', other.id, '2026-11-01', '2026-11-30');
  store.setRunState(otherRun, 'partial');
  const filters: SearchFilters = { cities: city.id, source: 'kopis', from: '2026-10-01', to: '2026-10-31' };
  const originalFilters = JSON.stringify(filters), ids = [id];

  const pending = exportWorkbook(store, filters, ids);
  Object.assign(filters, { cities: other.id, source: 'culture', from: '2026-11-01', to: '2026-11-30' });
  ids.splice(0, ids.length, otherId);
  store.upsert({ ...row, title: 'TEST changed title' });
  store.bookmark(id, true, 'TEST changed note');
  store.setRunState(run, 'partial');
  store.close(); closed = true;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await pending as any);
  const sheet = workbook.getWorksheet('공연 목록')!, evidence = workbook.getWorksheet('조회 근거')!;
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getCell('A2').value, 'TEST province TEST district');
  assert.equal(sheet.getCell('B2').value, 'TEST original title');
  assert.equal(sheet.getCell('S2').value, 'TEST original note');
  assert.equal(evidence.getCell('B3').value, originalFilters, 'Query evidence belongs to the captured selection');
  assert.equal(evidence.getCell('B4').value, String(id), 'Selected IDs belong to the captured selection');
  assert.equal(evidence.getCell('B5').value, '선택 범위 수집 완료');
  assert.equal(evidence.getCell('B6').value, '1');
  assert.equal(evidence.rowCount, 17, 'Only the originally selected collection run is included');
  assert.deepEqual(['A17', 'B17', 'C17', 'D17', 'E17'].map(cell => evidence.getCell(cell).value),
    ['KOPIS', 'TEST province TEST district', '2026-10-01', '2026-10-31', 'complete']);
});
