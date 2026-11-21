// The model contract: what the engine draws from. createTableModel and createPivotModel build one from
// options + a data source; a custom model can be passed as `createGrid({ model })` (low-level: this
// contract may change in any release).

import type { Axis } from '../axes/axis.js';
import type { Condition, ViewKey } from '../query.js';
import type { SortState } from '../engine/dom.js';
import type {
  CellClassResult, CellContext, ColumnDef, CustomFilterApi, FilterValuesResult, HeaderContext, PivotLevels, Progress, Query, Renderer,
} from '../types.js';

export type AxisName = 'rows' | 'cols';

/** A loaded header label, or undefined while it is loading (the engine then requests it). */
export type LabelLookup = (axis: AxisName, level: number, index: number) => string | undefined;

/** An expand / collapse target. */
export interface GroupRef {
  level: number;
  group: number;
}

/** A header box: covers items a..b along its axis and header bands (or tiers) t0..t1. */
export interface Segment {
  key: string | number;
  a: number;
  b: number;
  t0: number;
  t1: number;
  /** undefined while loading. */
  label: string | undefined;
  cls?: string;
  /** Has a resize grip (single items only). */
  resizable?: boolean;
  sort?: ViewKey;
  filter?: ViewKey;
  column?: ColumnDef;
  source?: number;
  render?: Renderer<HeaderContext>;
  /** Clicking the label expands / collapses this group. */
  toggle?: GroupRef & { axis: AxisName; collapsed: boolean };
  // Set by the engine just before drawing:
  selected?: boolean;
  sortState?: SortState | null;
  filterOn?: boolean;
}

/** How cells of a source column are drawn. */
export interface ColumnInfo {
  column?: ColumnDef;
  format?: (value: any, ctx: CellContext | null) => string;
  cellClass?: (value: any, ctx: CellContext | null) => CellClassResult;
  renderCell?: Renderer<CellContext<any>>;
  /** Extra CSS classes for the column's cells (leading space). */
  cls: string;
  /** Whether any of format / cellClass / renderCell is set (cached by the engine). */
  hooks?: boolean;
}

export type ValueSearch = (search: string, signal: AbortSignal) => Promise<FilterValuesResult> | FilterValuesResult;

/** What the filter dialog shows for a key. */
export type FilterDescription =
  | { kind: 'number'; name: string }
  | { kind: 'date'; name: string }
  | { kind: 'text'; name: string }
  | { kind: 'values'; name: string; values?: string[]; search?: ValueSearch }
  | { kind: 'custom'; name: string; render: Renderer<CustomFilterApi>; op: string; column?: ColumnDef };

/** The query in both formats: request parameters (signatures) and the public query. */
export interface ViewRequest {
  sort: string;
  filter: string;
  colfilter: string;
  query: Query;
}

export interface ApplyViewRequest extends ViewRequest {
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

export interface GridModel {
  /** Class added to the host element (vg-table / vg-pivot). */
  hostClass?: string;
  rows: Axis;
  cols: Axis & { setSize?(i: number, px: number): void };
  /** Rows before filtering (for limits and "filtered from" texts). */
  totalRows?: number;
  /** Row header columns, outermost first. */
  rowBands: { name: string; width: number }[];
  /** Column header rows, outermost first. */
  colTiers: { name: string; height: number }[];
  /** Extra CSS classes for a body row / column (leading space: subtotals, zebra). */
  rowKind(r: number): string;
  colKind(c: number): string;
  /** Header segments overlapping items [a, b]. */
  rowSegments(a: number, b: number, label: LabelLookup): Segment[];
  colSegments(a: number, b: number, label: LabelLookup): Segment[];
  columnInfo?(src: number): ColumnInfo | undefined;

  // Visible <-> source (identity when absent).
  rowSource?(r: number): number;
  colSource?(c: number): number;
  rowSourceCount?: number;
  colSourceCount?: number;
  /** False for items standing for many source items (collapsed groups): merges split around them. */
  rowExact?(r: number): boolean;
  colExact?(c: number): boolean;
  /** Source index to keep in place across a collapse / expand. */
  anchorOf?(axis: AxisName, i: number): number;
  /** Visible index of a source item, and whether it is shown exactly (not inside a collapsed group). */
  visibleOf?(axis: AxisName, src: number): [number, boolean];
  /** Column key of a source column, and back. */
  keyOf?(src: number): string | undefined;
  colOfKey?(key: string | undefined): number;

  // Expand / collapse (pivots).
  levels?: PivotLevels;
  groupStart?(axis: AxisName, level: number, group: number): number;
  expandTarget?(axis: AxisName, i: number): GroupRef | null;
  collapseTarget?(axis: AxisName, i: number): GroupRef | null;
  toggleGroup?(axis: AxisName, level: number, group: number): void;
  showLevel?(axis: AxisName, level: number): void;
  expandAll?(axis: AxisName): void;

  // Sorting and filtering.
  /** Largest row count the data source sorts by several keys / filters. */
  sortLimit?: number;
  filterLimit?: number;
  /** The data source applies column filters (columns are renumbered) vs the model hiding columns itself. */
  serverColFilter?: boolean;
  rowBandSort?(band: number): ViewKey | null;
  rowBandFilter?(band: number): ViewKey | null;
  colTierFilter?(tier: number): ViewKey | null;
  colSortKey?(c: number): ViewKey | null;
  colFilterKey?(c: number): ViewKey | null;
  /** Display name of a key ("Amount", "City", "FY 2002 · Q1"). */
  sortKeyName?(key: ViewKey, label: LabelLookup): string | undefined;
  filterOptions?(key: ViewKey, label: LabelLookup): FilterDescription | null | Promise<FilterDescription | null>;
  /** The data changed (refresh): fetch the layout again. */
  reload?(request: ViewRequest): Promise<void>;
  /** Sort / filter / column filter changed: update rows / cols. Throws (or rejects) to refuse. */
  applyView?(request: ApplyViewRequest): Promise<void>;
}

/** Initial query of a model, as request signatures (the engine and the model agree on them). */
export interface InitialView {
  filter?: string;
  colfilter?: string;
}

export type { Condition };
