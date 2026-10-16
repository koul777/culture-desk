import type { SnapshotFallback } from '../../shared/types';

export function readSnapshotFallback(payload: unknown): SnapshotFallback | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as { fallback?: unknown }).fallback;
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SnapshotFallback>;
  return candidate.mode === 'snapshot' && candidate.reason === 'database_unavailable'
    && typeof candidate.snapshotAt === 'string' && Number.isFinite(Date.parse(candidate.snapshotAt))
    ? { mode: 'snapshot', snapshotAt: candidate.snapshotAt, reason: 'database_unavailable' } : null;
}

/** Only a newer healthy bootstrap clears snapshot mode; stale responses cannot undo an outage or recovery. */
export function createSnapshotAvailability() {
  let sequence = 0;
  let observed = 0;
  let fallback: SnapshotFallback | null = null;
  const listeners = new Set<(value: SnapshotFallback | null) => void>();
  return {
    begin: () => ++sequence,
    get: () => fallback,
    subscribe: (listener: (value: SnapshotFallback | null) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    observe: (request: number, payload: unknown, healthyBootstrap = false) => {
      const next = readSnapshotFallback(payload);
      if (request < observed || (!next && !healthyBootstrap)) return;
      observed = request;
      if (next?.snapshotAt === fallback?.snapshotAt && !!next === !!fallback) return;
      fallback = next;
      for (const listener of listeners) listener(fallback);
    },
  };
}

export const snapshotAvailability = createSnapshotAvailability();
