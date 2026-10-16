export function today(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
export function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function addDays(value: string, days: number): string {
  const d = new Date(value + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
export function dateChunks(from: string, to: string, size = 31): { from: string; to: string }[] {
  if (!isDate(from) || !isDate(to) || from > to) throw new Error('올바른 시작일과 종료일을 선택하세요.');
  const chunks = [];
  for (let cursor = from; cursor <= to;) {
    const end = [addDays(cursor, size - 1), to].sort()[0];
    chunks.push({ from: cursor, to: end }); cursor = addDays(end, 1);
  }
  return chunks;
}
