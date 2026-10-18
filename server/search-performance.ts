/** Optional sequential diagnostics for offline profiling; never enabled by an HTTP parameter. */
export interface SearchPerformanceEvent {
  phase: string;
  durationMs: number;
  rows?: number;
  bytes?: number;
}
export type SearchPerformanceTrace = (event: SearchPerformanceEvent) => void;
