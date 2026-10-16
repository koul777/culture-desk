export const DEFAULT_ASSUMED_HEIGHT = 12;
export const MIN_ASSUMED_HEIGHT = 3;
export const MAX_ASSUMED_HEIGHT = 80;
export interface BuildingHeight {
  heightMeters: number | null;
  heightSource: 'tag' | 'levels' | 'unknown';
  estimatedHeight: boolean;
}
/** Preview assumptions never modify the source building or imply a measured height. */
export function venueHeightModel(building: BuildingHeight | null, assumedHeight = DEFAULT_ASSUMED_HEIGHT) {
  if (!building) return null;
  if (typeof building.heightMeters === 'number' && Number.isFinite(building.heightMeters) && building.heightMeters > 0) {
    const estimated = building.heightSource === 'levels' || building.estimatedHeight;
    return { kind: estimated ? 'levels' as const : 'provided' as const, meters: building.heightMeters,
      label: estimated ? '층수 기반 추정 모형' : '기록 높이 모형' };
  }
  const meters = Number.isFinite(assumedHeight) ? Math.min(MAX_ASSUMED_HEIGHT, Math.max(MIN_ASSUMED_HEIGHT, assumedHeight)) : DEFAULT_ASSUMED_HEIGHT;
  return { kind: 'assumed' as const, meters, label: '높이 가정 모형 · 실측 아님' };
}
/** Fit the footprint and vertical extent to the narrower viewport angle. */
export function buildingCameraRange(radius: number, height: number, aspect: number) {
  const boundedRadius = Math.max(1, Number.isFinite(radius) ? radius : 30);
  const boundedHeight = Math.max(0, Number.isFinite(height) ? height : 0);
  const safeAspect = Math.max(.25, Number.isFinite(aspect) ? aspect : 1);
  // Cesium's 60° perspective FOV is along the larger viewport dimension.
  const halfField = Math.atan(Math.tan(Math.PI / 6) * Math.min(safeAspect, 1 / safeAspect));
  return Math.max(85, Math.hypot(boundedRadius, boundedHeight / 2) / Math.sin(halfField) * 1.24);
}
/** Distances derive from the live camera, preserving manual pan and wheel changes. */
export function zoomedDistance(distance: number, direction: 'in' | 'out') {
  const value = Number.isFinite(distance) ? Math.max(0, distance) : 380;
  return Math.min(25000, Math.max(35, value * (direction === 'in' ? .76 : 1.32)));
}
