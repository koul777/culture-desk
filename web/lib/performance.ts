/** Optional local profiling. The application never enables or installs a global collector. */
export type PerformanceDetail = Record<string, string | number | boolean | undefined>;
export interface ResultTrace {
  requestId: number;
  filterKey: string;
  dataSource: 'search' | 'page' | 'map';
  page?: number;
}

function enabled(): boolean {
  return typeof window !== 'undefined'
    && (window as Window & { __CULTURE_PERFORMANCE__?: boolean }).__CULTURE_PERFORMANCE__ === true;
}

export function markPerformance(name: string, detail: PerformanceDetail): void {
  if (enabled()) performance.mark(`culture:${name}`, { detail });
}

export function startPerformanceMeasure(name: string, detail: PerformanceDetail): () => void {
  if (!enabled()) return () => {};
  const start = performance.now();
  return () => { performance.measure(`culture:${name}`, { start, end: performance.now(), detail }); };
}

export function measurePerformance<T>(name: string, detail: PerformanceDetail, task: () => T): T {
  const finish = startPerformanceMeasure(name, detail);
  try { return task(); } finally { finish(); }
}

/** Two frames allow committed DOM and layout to paint; obsolete work cancels both frames. */
export function markAfterPaint(name: string, detail: PerformanceDetail): () => void {
  if (!enabled()) return () => {};
  let active = true;
  let frame = window.requestAnimationFrame(() => {
    if (!active) return;
    frame = window.requestAnimationFrame(() => { if (active) markPerformance(name, detail); });
  });
  return () => { active = false; window.cancelAnimationFrame(frame); };
}
