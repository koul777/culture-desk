export type Source = 'kopis' | 'culture';
export type Genre = '연극' | '뮤지컬' | '음악' | '국악' | '무용' | '복합공연' | '기타';
export type DetailState = 'pending' | 'complete' | 'failed';
export type PriceType = 'free' | 'paid' | 'unknown';
export type Classification = 'performance' | 'excluded' | 'review';
export interface City {
  id: string; name: string; sido: string; sigungu: string;
  kopisSido: string; kopisSigungu: string; aliases: string[];
  /** Approximate city centre, never a performance venue position. */
  latitude?: number; longitude?: number;
}
export interface PerformanceInput {
  source: Source; sourceId: string; title: string; cityId: string;
  startDate: string; endDate: string; genre: Genre; sourceGenre: string;
  venue: string; address: string; poster: string; sourceUrl: string;
  latitude?: number; longitude?: number; locationPrecision?: 'venue' | 'city';
  price: string; priceType: PriceType; age: string; runtime: string;
  cast: string; producer: string; organizer: string; contact: string;
  schedule: string; description: string; status: string;
  detailState: DetailState; classification: Classification; reviewReason: string;
  raw: unknown;
}
export interface Performance extends Omit<PerformanceInput, 'raw'> {
  id: number; updatedAt: string; bookmarked: boolean; note: string;
}
/** Only fields used by venue markers and 3D launchers. Full details are fetched by ID. */
export type MapPerformance = Pick<Performance,
  'id' | 'title' | 'venue' | 'cityId' | 'startDate' | 'endDate' | 'source'
  | 'latitude' | 'longitude' | 'locationPrecision'>;
export type SyncState = 'queued' | 'running' | 'partial' | 'quota_wait' | 'paused' | 'complete';
export interface SyncRun {
  id: number; source: Source; cityId: string; from: string; to: string;
  detailOnly: boolean;
  state: SyncState; createdAt: string; updatedAt: string;
  tasksTotal: number; tasksDone: number; tasksFailed: number;
  items: number; excluded: number; review: number; error: string;
}
export interface SourceStatus {
  source: Source; label: string; configured: boolean; count: number;
  lastSync: string | null; applicationUrl: string;
}
export interface PublicRefreshStatus {
  status: 'idle' | 'running' | 'retry_wait' | 'failed' | 'complete' | 'unavailable';
  day: string | null; from: string | null; to: string | null;
  lastSuccessAt: string | null; updatedAt: string | null;
  counts: { expectedRuns: number; completeRuns: number; totalTasks: number; doneTasks: number; remaining: number; performances: number } | null;
  error: string | null;
  schedule: { timezone: 'Asia/Seoul'; primary: string; retries: readonly string[] };
}
export interface SnapshotFallback {
  mode: 'snapshot'; snapshotAt: string; reason: 'database_unavailable';
}
export interface Bootstrap {
  fallback?: SnapshotFallback;
  deployment?: 'local' | 'cloud';
  automaticRefresh?: PublicRefreshStatus & { enabled: boolean };
  cities: City[]; sources: SourceStatus[]; bookmarkCount: number;
  pendingDetails: number; reviewCount: number; excludedCount: number;
  runs: SyncRun[]; today: string;
}
export interface SearchFilters {
  cities?: string; from?: string; to?: string; genre?: string; q?: string;
  status?: 'upcoming' | 'ongoing' | 'ended' | '';
  price?: PriceType | ''; age?: string; source?: Source | '';
  bookmarked?: string; page?: string; limit?: string;
}
export interface SearchResult {
  fallback?: SnapshotFallback;
  items: Performance[]; total: number; page: number; pages: number;
  sourceCounts: Record<Source, number>; pendingDetails: number;
  partial: boolean; snapshotAt: string;
}
export interface MapResult extends Omit<SearchResult, 'items'> {
  items: MapPerformance[]; truncated: boolean;
}
export interface SyncRequest { cities: string[]; sources: Source[]; from: string; to: string }
export interface ListRequest { city: City; from: string; to: string; page: number; pageSize: number }
export interface ListResponse { items: PerformanceInput[]; hasMore: boolean; total?: number }
export interface Provider {
  source: Source;
  list(request: ListRequest, signal?: AbortSignal): Promise<ListResponse>;
  detail(item: PerformanceInput, signal?: AbortSignal): Promise<PerformanceInput>;
}
