export const MAP_MAX_ITEMS = 10000;
export const MAP_MAX_BYTES = 3 * 1024 * 1024;
// One extra selected row distinguishes an exact-size result from a truncated map.
export const MAP_QUERY_ROWS = MAP_MAX_ITEMS + 1;
// Near the marker cap, materialization/sorting costs more than the rows it saves.
// Keep the existing plan until a substantially larger selection can be discarded.
export const MAP_CTE_MIN_ROWS = 2 * MAP_QUERY_ROWS;
