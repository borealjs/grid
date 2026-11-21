// @borealjs/grid-core — a DOM virtual grid for any number of rows and columns, fed by callbacks.

// The grid
export { createGrid, Grid } from './grid.js';
export { DEFAULT_MESSAGES } from './messages.js';
export { EMPTY_QUERY } from './query.js';
export { defaultFormat } from './format.js';
export type * from './types.js';

// Data sources
export { createArraySource, compareValues, type ArraySource, type ArraySourceOptions, type FilterFn } from './sources/array.js';
export { createHttpSource, type HttpSourceOptions } from './sources/http.js';
export { createRowSource, type RowSource, type RowSourceOptions } from './sources/rows.js';

// Low-level pieces, for custom layouts and tooling. These may change in any release.
export { GridEngine, type EngineOptions, type FetchContext, type DrawnWindow } from './engine/engine.js';
export { BlockCache, type BlockCacheOptions } from './engine/block-cache.js';
export { UniformAxis, type Axis } from './axes/axis.js';
export { ResizableAxis } from './axes/resizable.js';
export { TreeAxis, type TreeLocation } from './axes/tree.js';
export { createTableModel } from './model/table.js';
export { createPivotModel } from './model/pivot.js';
export type { GridModel, Segment, ColumnInfo, FilterDescription, LabelLookup, AxisName } from './model/types.js';

import { GridEngine } from './engine/engine.js';
/** @deprecated Renamed to GridEngine (React's component is also called VirtualGrid). */
export const VirtualGrid = GridEngine;
/** @deprecated Renamed to GridEngine. */
export type VirtualGrid = GridEngine;
