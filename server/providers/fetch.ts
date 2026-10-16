import { ProviderError } from './errors.js';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 30000;

export interface HttpOptions {
  fetch?: FetchFn;
  timeoutMs?: number;
  apiKey?: string;
}

export function buildQueryString(params: Record<string, string | number | undefined>, serviceKey?: string): string {
  const parts: string[] = [];
  if (serviceKey !== undefined) {
    parts.push(serviceKey.includes('%') ? `serviceKey=${serviceKey}` : `serviceKey=${encodeURIComponent(serviceKey)}`);
  }
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

export async function fetchText(
  url: string,
  signal?: AbortSignal,
  options: HttpOptions = {},
): Promise<string> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) controller.abort();
  try {
    controller.signal.throwIfAborted();
    const response = await fetchFn(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new ProviderError('auth', `http ${response.status}`);
      if (response.status === 429) throw new ProviderError('quota', `http ${response.status}`);
      throw new ProviderError('network', `http ${response.status}`);
    }
    return text;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if ((error as Error).name === 'AbortError') throw new ProviderError('network', 'timeout');
    throw new ProviderError('network', 'fetch failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
