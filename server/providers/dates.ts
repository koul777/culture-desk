export function toIsoDate(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:$|[\sT.])/) ?? raw.match(/^(\d{4})(\d{2})(\d{2})(?:$|[\sT])/);
  if (!match) return '';
  const iso = `${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === iso ? iso : '';
}

export function toKopisDate(iso: string): string {
  return iso.replace(/-/g, '');
}

export function daysInclusive(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / 86400000) + 1;
}
