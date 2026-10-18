/** Byte ZIP metadata is nondeterministic; compare every worksheet value and visible format. */
export async function workbookSemantics(bytes: Buffer) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as any);
  const evidence = workbook.getWorksheet('조회 근거');
  if (!evidence || evidence.getCell('A2').value !== '추출 시각' || typeof evidence.getCell('B2').value !== 'string'
    || !Number.isFinite(Date.parse(evidence.getCell('B2').value as string))) throw new Error('Export extraction-time contract changed');
  const extractionTime = evidence.getCell('B2').value;
  evidence.getCell('B2').value = '<per-read extraction timestamp>';
  const payload = { creator: workbook.creator, worksheets: workbook.worksheets.map(sheet => {
    // ExcelJS columnCount scans all rows; read dimensions once before the cell walk.
    const rowCount = sheet.rowCount, columnCount = sheet.columnCount;
    return { name: sheet.name,
    rowCount, columnCount, columns: sheet.columns.map(column => ({ width: column.width, hidden: column.hidden })),
    views: sheet.views, autoFilter: sheet.autoFilter,
    rows: Array.from({ length: rowCount }, (_, row) => Array.from({ length: columnCount }, (_, column) => {
      const cell = sheet.getCell(row + 1, column + 1);
      return { value: cell.value, style: cell.style, numFmt: cell.numFmt };
    })),
  }; }), exportedRows: workbook.getWorksheet('공연 목록')!.rowCount - 1 };
  return { payload, extractionTime, created: workbook.created };
}
