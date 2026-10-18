import type { BuildingHeight } from './venue-3d';

export interface VenueBuilding extends BuildingHeight {
  type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][];
  name: string; sourceUrl: string; osmType: string; osmId: number;
  confidence: 'coordinate_and_name' | 'coordinate' | 'name_nearby'; matchMethod: string; distanceMeters: number;
}
export interface BuildingResult {
  status: 'available' | 'unavailable'; performanceId: number; source: string; attribution: string;
  building: VenueBuilding | null; message: string; reason?: string; checkedAt: string;
}
export type BuildingOutcome = { kind: 'result'; value: BuildingResult }
  | { kind: 'failed'; reason: 'timeout' | 'upstream_unavailable' }
  | { kind: 'cancelled' };
export interface BuildingRequest {
  result: Promise<BuildingOutcome>;
  cancel: () => void;
}

// This module must stay independent of Cesium so the selected OSM request can
// overlap its renderer chunk. Each opening owns a fresh browser consumer.
// The server retains ownership of any shared upstream lookup/cache.
export function startVenueBuildingRequest(performanceId: number): BuildingRequest {
  const controller = new AbortController();
  let cancelled = false, timedOut = false;
  // The server can try two providers for up to 10 seconds each.
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 25_000);
  const result = (async (): Promise<BuildingOutcome> => {
    try {
      const response = await fetch(`/api/venues/building?performanceId=${performanceId}`, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error('Building request failed');
      const value = await response.json() as BuildingResult;
      if (cancelled) return { kind: 'cancelled' };
      if (timedOut) return { kind: 'failed', reason: 'timeout' };
      return { kind: 'result', value };
    } catch {
      if (cancelled) return { kind: 'cancelled' };
      return { kind: 'failed', reason: timedOut ? 'timeout' : 'upstream_unavailable' };
    } finally { clearTimeout(timer); }
  })();
  // Always settle to an outcome: the renderer may still be loading or may fail
  // before it attaches a consumer. Cancellation never becomes a visible error.
  return { result, cancel: () => { cancelled = true; clearTimeout(timer); controller.abort(); } };
}
