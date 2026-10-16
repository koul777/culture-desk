/** Fixed projected-pixel cells keep nearby venues together at each zoom without dropping records. */
export function clusterProjectedPoints<T extends { x: number; y: number }>(points: readonly T[], zoom: number, cellSize = 76): T[][] {
  if (zoom >= 14) return points.map(point => [point]);
  const cells = new Map<string, T[]>();
  for (const point of points) {
    const key = `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`;
    const group = cells.get(key);
    if (group) group.push(point); else cells.set(key, [point]);
  }
  const groups = [...cells.values()].map(members => ({ members, x: members.reduce((sum, point) => sum + point.x, 0), y: members.reduce((sum, point) => sum + point.y, 0) }));
  // Adjacent grid cells can have centroids near their shared edge. Merge those too so the
  // 54px cluster circles remain legible instead of merely moving the overlap elsewhere.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i], b = groups[j];
      const dx = a.x / a.members.length - b.x / b.members.length;
      const dy = a.y / a.members.length - b.y / b.members.length;
      if (Math.abs(dx) >= 58 || Math.abs(dy) >= 58 || dx * dx + dy * dy >= 58 * 58) continue;
      a.members.push(...b.members); a.x += b.x; a.y += b.y;
      groups.splice(j--, 1); changed = true;
    }
    if (!changed) break;
  }
  return groups.map(group => group.members);
}
