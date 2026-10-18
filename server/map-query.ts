import type { MapPerformance } from '../shared/types.js';

const fields = ['title', 'venue', 'cityId', 'startDate', 'endDate', 'latitude', 'longitude', 'locationPrecision', 'source'] as const;

// SQLite projects a compact JSON tuple before crossing the JS boundary. Presence bits distinguish
// absent fields from explicit JSON nulls, preserving the original marker serialization exactly.
export const MAP_ROW_COLUMNS = `p.id,json_extract(p.data,${fields.map(field => `'$.${field}'`).join(',')}) AS marker_values,
  (${fields.map((field, index) => `(CASE WHEN json_type(p.data,'$.${field}') IS NULL THEN 0 ELSE ${1 << index} END)`).join('+')}) AS marker_fields`;

export function mapQueryRow(row: Record<string, any>): MapPerformance {
  const values = JSON.parse(row.marker_values);
  const present = Number(row.marker_fields);
  return {
    id: Number(row.id), title: present & 1 ? values[0] : undefined, venue: present & 2 ? values[1] : undefined,
    cityId: present & 4 ? values[2] : undefined, startDate: present & 8 ? values[3] : undefined,
    endDate: present & 16 ? values[4] : undefined, latitude: present & 32 ? values[5] : undefined,
    longitude: present & 64 ? values[6] : undefined, locationPrecision: present & 128 ? values[7] : undefined,
    source: present & 256 ? values[8] : undefined,
  };
}
