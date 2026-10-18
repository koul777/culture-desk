import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { workbookSemantics } from '../scripts/performance/workbook.js';
import { semanticHash } from '../scripts/performance/common.js';

test('export verification preserves worksheet semantics and bounds dimension scans', async () => {
  const make = async (extractionTime: string) => {
    const workbook = new ExcelJS.Workbook(); workbook.creator = 'Culture Desk';
    const shows = workbook.addWorksheet('공연 목록');
    shows.addRow(['도시', '공연명']);
    for (let index = 0; index < 500; index++) shows.addRow(['서울', `공연 ${index}`]);
    shows.getCell('B2').font = { bold: true }; shows.columns = [{ width: 20 }, { width: 40 }];
    const evidence = workbook.addWorksheet('조회 근거');
    evidence.addRows([['항목', '내용'], ['추출 시각', extractionTime], ['스냅샷 기준 시각', '2026-10-17T02:48:36.917Z']]);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  };
  const first = await make('2026-10-18T15:00:00.000Z'), second = await make('2026-10-18T16:00:00.000Z');
  const probe = new ExcelJS.Workbook().addWorksheet('probe');
  const prototype = Object.getPrototypeOf(probe), descriptor = Object.getOwnPropertyDescriptor(prototype, 'columnCount')!;
  let scans = 0;
  Object.defineProperty(prototype, 'columnCount', { ...descriptor, get() { scans++; return descriptor.get!.call(this); } });
  try {
    const a = await workbookSemantics(first), b = await workbookSemantics(second);
    // Allow internal parser calls, but not a full worksheet scan for each row.
    assert.ok(scans <= 20, `Column dimension getter called ${scans} times for two small workbooks`);
    assert.equal(semanticHash(a.payload), semanticHash(b.payload));
    assert.equal(a.payload.exportedRows, 500);
    assert.equal(a.payload.worksheets[0].rows[1][1].style.font?.bold, true);
    assert.equal(a.payload.worksheets[1].rows[2][1].value, '2026-10-17T02:48:36.917Z');
    assert.notEqual(a.extractionTime, b.extractionTime);
  } finally { Object.defineProperty(prototype, 'columnCount', descriptor); }
});

test('export semantic hashes distinguish actual date cells from other dates and text', async () => {
  const make = async (value: ExcelJS.CellValue) => {
    const workbook = new ExcelJS.Workbook(); workbook.creator = 'Culture Desk';
    const shows = workbook.addWorksheet('공연 목록');
    shows.addRow(['값']); shows.addRow([value]); shows.getCell('A2').numFmt = 'yyyy-mm-dd';
    const evidence = workbook.addWorksheet('조회 근거');
    evidence.addRows([['항목', '내용'], ['추출 시각', '2026-10-18T15:00:00.000Z']]);
    return workbookSemantics(Buffer.from(await workbook.xlsx.writeBuffer()));
  };
  const first = await make(new Date('2026-10-18T00:00:00.000Z'));
  const second = await make(new Date('2026-10-19T00:00:00.000Z'));
  const text = await make('2026-10-18T00:00:00.000Z');
  assert.ok(first.payload.worksheets[0].rows[1][0].value instanceof Date, 'Parser returned an actual date cell');
  assert.notEqual(semanticHash(first.payload), semanticHash(second.payload), 'Different dates must not collapse to empty objects');
  assert.notEqual(semanticHash(first.payload), semanticHash(text.payload), 'Date and text cell types remain distinct');
});
