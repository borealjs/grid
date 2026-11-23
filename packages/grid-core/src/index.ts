// @borealjs/grid-core — a DOM virtual grid for any number of rows and columns, fed by callbacks.

// The grid
export { createGrid, Grid } from './grid.js';
export { DEFAULT_MESSAGES } from './messages.js';
export { EMPTY_QUERY } from './query.js';
export { defaultFormat } from './format.js';
export type * from './types.js';

// Data sources (a plain array or `{ getRows }` object can be passed as `data` directly)
export { createArraySource, compareValues, type ArraySource, type ArraySourceOptions, type FilterFn } from './sources/array.js';
export { createHttpSource, type HttpSourceOptions } from './sources/http.js';

// Pivot layouts: turns a TreeSpec into positions of groups, subtotals and leaves (for pivot data sources).
export { TreeAxis, type TreeLocation } from './axes/tree.js';
