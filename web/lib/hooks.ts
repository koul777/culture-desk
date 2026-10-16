import { useCallback, useEffect, useRef, useState } from 'react';

export function useInterval(callback: () => void, delay: number | null): void {
  const saved = useRef(callback);
  useEffect(() => { saved.current = callback; }, [callback]);
  useEffect(() => {
    if (delay === null) return;
    const id = window.setInterval(() => saved.current(), delay);
    return () => window.clearInterval(id);
  }, [delay]);
}

/**
 * Tracks in-flight actions by key. The ref guard blocks a second click that lands
 * before React re-renders the disabled button.
 */
export function useBusy() {
  const inFlight = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const run = useCallback(async <T,>(key: string, task: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current.has(key)) return undefined;
    inFlight.current.add(key);
    setBusy(new Set(inFlight.current));
    try { return await task(); }
    finally {
      inFlight.current.delete(key);
      setBusy(new Set(inFlight.current));
    }
  }, []);
  const is = useCallback((key: string) => busy.has(key), [busy]);
  return { run, is, any: busy.size > 0 };
}

export type View = 'search' | 'map' | 'table' | 'connection';
const VIEWS: View[] = ['search', 'map', 'table', 'connection'];
const readHash = (): View => {
  const value = window.location.hash.replace(/^#\/?/, '');
  return (VIEWS as string[]).includes(value) ? value as View : 'search';
};

/** Views live in the URL hash so browser back/forward and bookmarks work. */
export function useHashView(): [View, (view: View) => void] {
  const [view, setView] = useState<View>(readHash);
  useEffect(() => {
    const onChange = () => setView(readHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const go = useCallback((next: View) => { window.location.hash = next; }, []);
  return [view, go];
}

export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
