import type { City } from '../../shared/types';

/** Serialize bootstrap reads without letting a post-write refresh reuse a pre-write snapshot. */
export function createBootstrapRefresh<T>(read: () => Promise<T>, now = Date.now) {
  let pending: Promise<T> | undefined;
  let lastSuccessAt: number | undefined;

  const shared = (): Promise<T> => {
    if (pending) return pending;
    const request = Promise.resolve().then(read).then(value => {
      lastSuccessAt = now();
      return value;
    }).finally(() => {
      if (pending === request) pending = undefined;
    });
    pending = request;
    return request;
  };

  return {
    /** Internal polls and visibility events may join an existing read. */
    shared,
    /** A caller following a write always gets a read started after this call. */
    fresh: (): Promise<T> => pending
      ? pending.catch(() => undefined).then(shared)
      : shared(),
    /** A tick's successful refresh also satisfies a nearby progress poll. */
    isDue: (intervalMs: number): boolean => lastSuccessAt === undefined || now() - lastSuccessAt >= intervalMs,
  };
}

/** Keep map marker dependencies stable while retaining every other progress/status update. */
export function preserveCityReference<T extends { cities: City[] }>(previous: T | null, next: T): T {
  if (!previous || previous.cities.length !== next.cities.length) return next;
  // The small region catalogue is compared, never the changing full bootstrap payload.
  return JSON.stringify(previous.cities) === JSON.stringify(next.cities)
    ? { ...next, cities: previous.cities }
    : next;
}
