import type {
  Bootstrap, City, MapResult, Performance, SearchFilters, SearchResult, Source, SyncRequest, SyncRun,
} from '../shared/types';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'ApiError'; }
}

const OFFLINE = '서버에 연결할 수 없습니다. Culture Desk가 실행 중인지 확인한 뒤 다시 시도하세요.';

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: unknown } | null;
  if (body && typeof body.error === 'string' && body.error.trim()) return body.error;
  return `요청을 처리하지 못했습니다. (HTTP ${res.status})`;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try { res = await fetch(path, { credentials: 'same-origin', ...init }); }
  catch { throw new ApiError(OFFLINE, 0); }
  if (!res.ok) {
    throw new ApiError(await readError(res), res.status);
  }
  return res;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init);
  try { return await res.json() as T; }
  catch { throw new ApiError('서버 응답을 읽을 수 없습니다.', res.status); }
}

/** Bound only the shared status read; long collection and export requests keep their own lifecycle. */
async function bootstrap(): Promise<Bootstrap> {
  const controller = new AbortController();
  const timeoutError = new ApiError('서버 상태 조회가 30초를 초과했습니다. 다시 연결해 주세요.', 408);
  const timer = setTimeout(() => controller.abort(timeoutError), 30_000);
  try {
    const result = await json<Bootstrap>('/api/bootstrap', { signal: controller.signal });
    // Body decoding may finish after cancellation; a late snapshot must never reach app state.
    if (controller.signal.aborted) throw timeoutError;
    return result;
  } catch (error) {
    throw controller.signal.aborted ? timeoutError : error;
  } finally {
    clearTimeout(timer);
  }
}

/** Every state-changing request carries the JSON content type and the local-app header. */
function mutate<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown = {}): Promise<T> {
  return json<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Culture-Request': '1' },
    body: JSON.stringify(body),
  });
}

export function queryString(filters: SearchFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (typeof value === 'string' && value !== '') params.set(key, value);
  }
  return params.toString();
}

export interface CityInput { name: string; sido: string; sigungu: string; kopisSido: string; kopisSigungu: string }

export const api = {
  cloudTick: () => mutate<{ ok: boolean }>('POST', '/api/cloud/tick'),
  bootstrap,
  search: (filters: SearchFilters) => json<SearchResult>(`/api/performances?${queryString(filters)}`),
  map: (filters: SearchFilters) => json<MapResult>(`/api/map?${queryString(filters)}`),
  performance: (id: number) => json<Performance>(`/api/performances/${id}`),
  requestDetail: (id: number) => mutate<{ queued: boolean }>('POST', `/api/performances/${id}/detail`),
  requestDetails: (filters: SearchFilters) => mutate<{ queued: number }>('POST', '/api/details', { filters }),
  startSync: (request: SyncRequest) => mutate<{ runs: SyncRun[]; skipped: Source[] }>('POST', '/api/sync', request),
  pauseRun: (id: number) => mutate<{ ok: true }>('POST', `/api/sync/${id}/pause`),
  resumeRun: (id: number) => mutate<{ ok: true }>('POST', `/api/sync/${id}/resume`),
  addCity: (city: CityInput) => mutate<City>('POST', '/api/cities', city),
  backup: () => mutate<{ filename: string }>('POST', '/api/backup'),
  reloadConfig: () => mutate<{ ok: true }>('POST', '/api/config/reload'),
  shutdown: () => mutate<{ ok: true }>('POST', '/api/shutdown'),
};

function filenameFrom(res: Response, fallback: string): string {
  const header = res.headers.get('content-disposition') || '';
  const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(header);
  const raw = match?.[1] ? decodeURIComponent(match[1]) : match?.[2];
  return raw && /^[\w.\- ]+\.xlsx$/i.test(raw) ? raw : fallback;
}

/** Downloads the Excel snapshot through fetch so server errors can be shown instead of saved as a file. */
export async function downloadExport(filters: SearchFilters, ids?: number[]): Promise<string> {
  const { page: _page, limit: _limit, ...rest } = filters;
  const qs = queryString(rest, ids?.length ? { ids: ids.join(',') } : {});
  const res = await send(`/api/export.xlsx${qs ? `?${qs}` : ''}`);
  const blob = await res.blob();
  const name = filenameFrom(res, 'culture-desk.xlsx');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return name;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return '알 수 없는 오류가 발생했습니다.';
}
