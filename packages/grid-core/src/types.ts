// Public types of @borealjs/grid-core: the query format, data sources, columns, options and events.
// Everything here is part of the stable API. Internal shapes live next to the code that uses them.

import type { Grid } from './grid.js';

// ------------------------------------------------------------------ query

export type SortDirection = 'asc' | 'desc';

/** Sort by a value column (source index, plus its key when columns have keys) or a pivot row dimension. */
export type SortItem =
  | { column: number; key?: string; direction: SortDirection }
  | { key: string; column?: number; direction: SortDirection }
  | { level: number; direction: SortDirection };

export type FilterCondition =
  | { op: 'range'; min?: number | string; max?: number | string }
  | { op: 'in' | 'notin'; values: string[] }
  | { op: 'contains'; text: string }
  | { op: string; value?: unknown };

/** Which column a filter applies to: a source index or key, or a pivot row dimension (`level`). */
export type FilterTargetRef = { column: number; key?: string } | { key: string; column?: number } | { level: number };

/** A row filter on a column (by source index or key) or a pivot row dimension (`level`). */
export type FilterItem = FilterCondition & FilterTargetRef;

/** Which columns are shown: on column groups (tables, level 0) or column dimensions (pivots). */
export type ColumnFilterItem = FilterCondition & { level: number };

export interface Query {
  sort: SortItem[];
  filter: FilterItem[];
  columnFilter: ColumnFilterItem[];
}

// ------------------------------------------------------------------ data source

/** A rectangle of cells: rows are positions in the sorted / filtered result, columns are column indexes. */
export interface CellRect {
  row: number;
  col: number;
  rowCount: number;
  colCount: number;
}

/** A merged cell: rows and columns as in CellRect (source coordinates). */
export interface Merge {
  r0: number;
  c0: number;
  nr: number;
  nc: number;
  label?: string;
}

/** Values of one rect: rows of values (`[[a, b], [c, d]]`) or one row-major array (`[a, b, c, d]`). */
export type RectValues<V = unknown> = V[][] | V[];

/** What getCells returns: one RectValues per requested rect, optionally with merged cells. */
export type CellsResult<V = unknown> = RectValues<V>[] | { cells: RectValues<V>[]; merges?: Merge[] };

export interface TableLayout {
  type?: 'table';
  /** Rows matching the query's filter. */
  rowCount: number;
  /** Rows without any filter (for "filtered from" texts). */
  totalRowCount?: number;
  columnCount?: number;
  /** false: the data source has getColumns but this table does not use it (e.g. an older server). */
  describedColumns?: boolean;
  /** Largest table a multi-column sort / a filter may be asked for (the grid refuses beyond). */
  maxSortRows?: number;
  maxFilterRows?: number;
  [extra: string]: unknown;
}

export interface TreeLevel {
  name: string;
  subtotal?: boolean;
  subtotalSize?: number;
  collapsible?: boolean;
}

/** Hierarchical axis (pivot rows or columns). */
export interface TreeSpec {
  levels: TreeLevel[];
  leafName: string;
  leafSize: number;
  roots: number;
  /** Per level, children per group: one number for every group, or one entry per group. */
  fanout: (number | number[])[];
  grandTotal?: boolean;
  grandSize?: number;
}

export interface PivotLayout {
  type: 'pivot';
  rows: TreeSpec;
  cols: TreeSpec;
  /** Per level: displayed group -> original group (when sorted / filtered). */
  rowMaps?: number[][];
  colMaps?: number[][];
}

export type Layout = TableLayout | PivotLayout;

/** How far a slow sort or filter is. `phase` is shown as is, e.g. "Checking rows". */
export interface Progress {
  phase?: string;
  done?: number;
  total?: number;
}

export interface FilterValuesRequest {
  /** Table column (source index) and its key, or a pivot dimension (`axis` + `level`). */
  column?: number;
  key?: string;
  axis?: 'rows' | 'cols';
  level?: number;
  search: string;
  /** At most this many values (1000): ask the user to refine the search beyond that. */
  limit: number;
  query: Query;
  signal?: AbortSignal;
}

export interface FilterValuesResult {
  values: string[];
  /** Distinct values in all. */
  total?: number;
  /** Values matching the search (when more than `values.length`, the dialog asks to refine it). */
  matches?: number;
}

export interface GetCellsRequest {
  rects: CellRect[];
  query: Query;
  signal?: AbortSignal;
}

/** A page of rows for getRows: rows `offset` … `offset + limit - 1` (`start` / `end` say the same). */
export interface GetRowsRequest {
  offset: number;
  limit: number;
  start: number;
  /** Exclusive. */
  end: number;
  /** Highest priority first; items carry the column `key` (when columns have keys). */
  sort: SortItem[];
  filter: FilterItem[];
  query: Query;
  signal?: AbortSignal;
  /** On the first page of a new sort or filter: report how far a slow one is (the grid shows it, with Cancel). */
  onProgress?(progress: Progress): void;
}

/** What getRows returns: the rows of the page and how many rows match the filter. */
export interface RowsResult<Row = any> {
  rows: Row[];
  total: number;
  /** Rows without any filter (for "filtered from" texts), when cheap to tell. */
  totalUnfiltered?: number;
}

/** A row's stable id (from getRowId). */
export type RowId = string | number;

/**
 * One step of row checking: a row by id, or rows `from` … `to` (positions) in the order of `query` (its sort
 * and filter). A range costs the same for 10 rows or 50 million.
 */
export type RowCheck =
  | { id: RowId; checked: boolean }
  | { from: number; to: number; query: Query; checked: boolean };

/**
 * Checked rows: steps in the order they were made; the last step that covers a row decides whether it is
 * checked. The header checkbox is one range over the whole view; clearing it empties the list.
 */
export interface RowSelection {
  checks: RowCheck[];
}

export interface GetLayoutRequest {
  query: Query;
  signal?: AbortSignal;
  onProgress?(progress: Progress): void;
}

/** A block of columns to describe: columns `start` … `start + count - 1` (under the query's column filter). */
export interface GetColumnsRequest {
  start: number;
  count: number;
  query: Query;
  signal?: AbortSignal;
}

/**
 * What a data source can tell about a column (getColumns): plain data, so a server can send it. Functions such
 * as `format` or `renderCell` come from `getColumn(index)` in code and win over these.
 */
export interface ColumnDescription {
  key?: string;
  title?: string;
  type?: 'text' | 'number' | 'date';
  width?: number;
  align?: 'start' | 'end' | 'center';
  sortable?: boolean;
  resizable?: boolean;
  reorderable?: boolean;
  group?: string;
  className?: string;
  headerClass?: string;
  filter?: false | 'text' | 'number' | 'date' | 'values' | { type: 'values'; values?: string[] };
}

export interface GetLabelsRequest {
  axis: 'rows' | 'cols';
  level: number;
  start: number;
  count: number;
  query: Query;
  signal?: AbortSignal;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Where the data comes from: getRows (pages of whole rows, offset / limit) or getCells (rectangles of
 * cells, for pivots and very wide tables). The grid asks only for what is on screen; every call gets an
 * AbortSignal (pass it to fetch so requests that are no longer needed are cancelled).
 */
export interface DataSource<V = unknown> {
  /**
   * Rows by offset / limit, as most backends serve them. Cells are read from the rows by column `key`
   * (or `value(row)`), and cell renderers and events get the row (`ctx.row`). Use this or getCells.
   */
  getRows?(request: GetRowsRequest): MaybePromise<RowsResult>;
  /** Cells of one or more rects (columns by index). Use this or getRows. */
  getCells?(request: GetCellsRequest): MaybePromise<CellsResult<V>>;
  /**
   * Row count (tables) or the row/column trees (pivots) for a query. Needed for filtering and pivots.
   * A slow sort or filter may report how far it is with onProgress; the grid shows it with a Cancel button,
   * and cancelling aborts `signal`.
   */
  getLayout?(request: GetLayoutRequest): MaybePromise<Layout>;
  /** Header labels for very large axes (pivot groups, column titles not given in column definitions). */
  getLabels?(request: GetLabelsRequest): MaybePromise<(string | null)[]>;
  /**
   * Describe columns on demand (tables with very many columns): one ColumnDescription per column asked for.
   * The grid asks for the columns on screen, so a million distinct columns keep their titles, types, filters
   * and widths without describing them all up front. With it, the column chooser asks the server too
   * (getFilterValues for `{ axis: 'cols', level: 0 }`, and the column filter in the query).
   */
  getColumns?(request: GetColumnsRequest): MaybePromise<ColumnDescription[]>;
  /** Distinct values for value-list filters (first `limit` matching `search`). */
  getFilterValues?(request: FilterValuesRequest): MaybePromise<FilterValuesResult>;
  /** The record at a position of the sorted / filtered view, if loaded (gives cells ctx.row). */
  rowAt?(position: number, query: Query): unknown;
  /**
   * Id of the row at a position, when known without its record (getCells sources whose server sends row
   * ids). Sources with records use getRowId on rowAt instead.
   */
  rowIdAt?(position: number, query: Query): RowId | undefined;
  /**
   * Position of the row with this id in the sorted / filtered view: -1 when it is not in it (filtered out,
   * deleted), null when the source cannot tell. Lets the selection and checked rows follow rows.
   */
  indexOfRow?(id: RowId, query: Query, getRowId: (row: any) => RowId): MaybePromise<number | null>;
  /** Drop cached data (grid.refresh() calls it). */
  clearCache?(): void;
  /** Rects per getCells call (default 400; 1 = one rect per call). */
  maxRectsPerRequest?: number;
  /** Cells per getCells call (default 20,000). */
  maxCellsPerRequest?: number;
  /** getRows sources: rows per request (default 100). */
  pageSize?: number;
  /** getRows sources: pages of rows kept in memory (default 300). */
  maxPages?: number;
}

// ------------------------------------------------------------------ columns and hooks

export interface CellContext<V = unknown> {
  /** Visible row / column index (-1 when the cell is not on screen, e.g. while copying). */
  rowIndex: number;
  colIndex: number;
  /** The data record behind the row, when the data source can tell (in-memory rows); otherwise undefined. */
  readonly row: any;
  /** Source row / column index (what the data source addressed). */
  rowSource: number;
  colSource: number;
  value: V;
  /** Text after `format` (for renderers). */
  text: string;
  column?: ColumnDef<V>;
  grid: Grid;
}

export interface HeaderContext {
  axis: 'rows' | 'cols';
  label: string;
  /** Header row (tier) or row-header column (band). */
  level: number;
  /** Visible item range the header covers. */
  start: number;
  end: number;
  column?: ColumnDef;
  source?: number;
  kind: string;
  sorted: SortDirection | null;
  sortPriority: number;
  filtered: boolean;
}

export interface EmptyContext {
  /** True when rows exist but none match the filter. */
  filtered: boolean;
}

/** Imperative renderer: draw into `el`; return a cleanup to undo it (otherwise the grid empties `el`). */
export type Renderer<C> = (el: HTMLElement, ctx: C) => void | (() => void);

export interface CustomFilterApi {
  /** The current value (undefined when not filtered). */
  value: unknown;
  condition: FilterItem | null;
  column?: ColumnDef;
  title: string;
  /** Stage a value; the dialog's Apply button sends it. */
  setValue(value: unknown): void;
  /** Apply now (null clears). Without an argument, applies the staged value. */
  apply(value?: unknown): void;
  clear(): void;
  close(): void;
}

export interface CustomFilter {
  /** Operator sent to the data source: { column, op, value }. Default 'custom'. */
  op?: string;
  render: Renderer<CustomFilterApi>;
}

export type FilterKind = false | 'text' | 'number' | 'date' | 'values' | { type: 'values'; values?: string[] } | CustomFilter;

export type CellClassResult = string | undefined | null | false;

export interface ColumnDef<V = unknown, Row = any> {
  /** Stable id: used in queries and events (`key`) and by the in-memory source as the field name. */
  key?: string;
  title?: string;
  /** 'number' aligns to the end and filters by range; 'date' filters by date range. */
  type?: 'text' | 'number' | 'date';
  width?: number;
  align?: 'start' | 'end' | 'center';
  sortable?: boolean;
  resizable?: boolean;
  hidden?: boolean;
  /**
   * Keep the column in view while scrolling sideways (tables): `'left'` (or `true`) moves it to the start,
   * `'right'` to the end.
   */
  pinned?: boolean | 'left' | 'right';
  /** false: the column cannot be dragged to another place. */
  reorderable?: boolean;
  /** Group name for the column chooser (column filter level 0). */
  group?: string;
  filter?: FilterKind;
  /** Value -> text shown in the cell (fastest way to customize a cell). */
  format?(value: V, ctx: CellContext<V> | null): string;
  /** Extra CSS class for a cell from its value. */
  cellClass?(value: V, ctx: CellContext<V> | null): CellClassResult;
  className?: string;
  headerClass?: string;
  renderCell?: Renderer<CellContext<V>>;
  renderHeader?: Renderer<HeaderContext>;
  /** In-memory source: read the value from a row (default row[key]). */
  value?(row: Row): V;
  /** In-memory source: compare two values for sorting. */
  compare?(a: V, b: V): number;
}

// ------------------------------------------------------------------ texts

export type ViewWork = 'sort' | 'filter' | 'columns';

export interface Messages {
  noRows: string;
  noData: string;
  filterTitle(name: string): string;
  min: string;
  max: string;
  from: string;
  to: string;
  contains: string;
  containsPlaceholder: string;
  find: string;
  searchValues(total?: number): string;
  all: string;
  none: string;
  loadingValues: string;
  noValues: string;
  refineSearch(shown: number, matches: number): string;
  valuesFailed(reason: string): string;
  clear: string;
  apply: string;
  selectAll: string;
  /** Row checkbox (rowSelection). */
  selectRow: string;
  selectAllRows: string;
  /** After a sort, filter or refresh, the selected row is not in the view any more (the selection is on the first row). */
  selectionRowGone: string;
  /** After a sort or filter, the grid could not tell where the selected row went (the selection is on the first row). */
  selectionNotFollowed: string;
  /** Some checked rows could not be placed in the current sort / filter (they stay checked). */
  checksNotShown: string;
  columns: string;
  applying: string;
  cancel: string;
  /** A sort or filter that takes a while: "Filtering… Checking rows · 42% · 7 s". */
  working(what: ViewWork, progress: Progress | null, seconds: number): string;
  filterLimit(limit: number, total: number): string;
  sortLimit(limit: number, total: number): string;
  failed(what: 'sort' | 'filter', reason: string): string;
  /** While cells that are not on screen load for a copy. */
  copying(cells: number): string;
  /** After a copy: "Copied 20 × 5 (100 cells)". */
  copied(info: CopyInfo): string;
  copyTooLarge(cells: number, limit: number): string;
  copyRefused: string;
  copyLoadFailed(reason: string): string;
  copyAgain(loaded: number, shortcut: string): string;
}

// ------------------------------------------------------------------ events

export interface CellPosition {
  r: number;
  c: number;
}

export interface SelectionRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface Selection {
  active: CellPosition;
  ranges: SelectionRange[];
}

export interface SelectionInfo {
  active: CellPosition;
  /** Text of the active cell (undefined while loading). */
  text: string | undefined;
  ranges: number;
  rows: number;
  cols: number;
  cells: number;
  /**
   * Set when the selection moved by itself after a sort, filter or refresh: its row is not in the view any
   * more ('rowGone'), or the grid could not tell where it went ('notFollowed'). It is then on the first row.
   */
  moved?: 'rowGone' | 'notFollowed';
}

export interface CopyInfo {
  ok: boolean;
  cells: number;
  ranges: number;
  rows: number;
  cols: number;
  fetched: number;
  ms: number;
  text?: string;
  reason?: string;
  retry?: boolean;
  plainOnly?: boolean;
  /** Why the clipboard refused, when it did. */
  cause?: string;
}

export interface ViewChangeInfo {
  pending?: boolean;
  /** While pending: how far the data source says it is. */
  progress?: Progress;
  ok?: boolean;
  /** The user (or grid.cancel()) stopped it. */
  cancelled?: boolean;
  what: ViewWork;
  reason?: string;
  rows?: number;
  cols?: number;
  totalRows?: number;
  sort?: string;
  filter?: string;
  droppedSorts?: number;
}

/** A click, double-click or context menu on a cell: the cell's context plus the DOM event. */
export interface CellEvent<V = unknown> extends CellContext<V> {
  /** The column's key (tables with keyed columns). */
  key?: string;
  event: MouseEvent | KeyboardEvent;
}

export interface ColumnResizeInfo {
  column: number;
  key?: string;
  width: number;
}

export interface ErrorContext {
  kind: 'layout' | 'cells' | 'labels';
}

// ------------------------------------------------------------------ options

/** What a sortable rule is asked about: a column, or a pivot row level. */
export type SortTarget = { axis: 'cols'; column: number; key?: string } | { axis: 'rows'; level: number };
/** What a filterable rule is asked about: a column, a pivot row level, or a column level (pivot dimensions; the column chooser is level 0). */
export type FilterTarget = SortTarget | { axis: 'cols'; level: number };

export type SelectionMode = 'multi' | 'single' | 'none';
export type Theme = 'auto' | 'light' | 'dark';

export interface RowHeaderOptions {
  width?: number;
  title?: string;
  label?(row: number): string;
}

/** The parts of the query: what onQueryChange says changed. */
export type QueryPart = 'sort' | 'filter' | 'columnFilter';

/** Rarely needed tuning. */
export interface AdvancedOptions {
  /** Rows / columns per cached data block (default 100 × 20). */
  blockRows?: number;
  blockCols?: number;
  /** Use ⌘ (true) or Ctrl (false) for shortcuts; detected from the platform by default. */
  isMac?: boolean;
}

export interface GridOptions<V = unknown> {
  /**
   * The data: an array of rows (sorted, filtered and searched in the browser), or a data source for your
   * backend: `{ getRows }` (rows by offset / limit), `{ getCells }` (cells by rectangle, any size), or
   * createHttpSource for the reference protocol.
   */
  data: DataSource<V> | readonly any[];
  /**
   * A row's stable id. The selection then follows rows through sorts, filters and refreshes (instead of
   * staying at the same position), and checked rows are kept by id. In-memory rows default to the row itself.
   */
  getRowId?(row: any): RowId;
  /** Table columns. For very wide tables use columnCount + getColumn instead. */
  columns?: ColumnDef<V>[];
  columnCount?: number;
  getColumn?(index: number): ColumnDef<V>;
  /** Row count when the data source has no getLayout. */
  rowCount?: number;
  /** A layout you already have (skips the first getLayout call). */
  layout?: Layout;
  rowHeight?: number;
  headerHeight?: number;
  columnWidth?: number;
  minColumnWidth?: number;
  /** Row-number column: false hides it; label(row) customizes it. */
  rowHeader?: false | RowHeaderOptions;
  /** Pivot row header column widths. */
  rowHeaderWidths?: number[];
  /** Column chooser on the corner (choose columns by `group`). Default: on when columns have groups. */
  columnChooser?: boolean;
  columnGroups?: string[];
  theme?: Theme;
  /** Accessible name of the grid, read by screen readers. */
  ariaLabel?: string;
  messages?: Partial<Messages>;

  // Features (all on by default)
  /** false turns sorting off; a function decides per column or pivot row level. */
  sortable?: boolean | ((target: SortTarget) => boolean);
  multiSort?: boolean;
  /** false turns filtering off; a function decides per column, pivot row level or pivot column level. */
  filterable?: boolean | ((target: FilterTarget) => boolean);
  resizable?: boolean;
  expandable?: boolean;
  selection?: SelectionMode;
  copy?: boolean;
  keyboard?: boolean;
  /** Rows can be checked with a checkbox in the row-number column (header checkbox: all rows). */
  rowSelection?: boolean;
  /** Columns can be dragged to another place by their header (tables). Default true. */
  reorderable?: boolean;
  /** Built-in notice for refused or failed sorts and filters (turn off if you show onViewChange yourself). */
  notices?: boolean;

  // Query: sort, row filter and column filter
  /** The query to start with. */
  defaultQuery?: Partial<Query>;
  /**
   * The current query, owned by you: the parts it has (sort, filter, columnFilter) are controlled. User
   * changes to them are only reported (onQueryChange); the grid shows what you pass back here.
   */
  query?: Partial<Query>;
  /** Checked rows (with rowSelection). Applied when it changes; onRowSelectionChange reports clicks. */
  selectedRows?: RowSelection;
  /**
   * Column order: keys (or source indexes) in display order. Very wide tables (getColumn) use a compact
   * form: source indexes and inclusive [first, last] runs, e.g. [[0, 4], 9, [5, 8], [10, 999999]].
   */
  columnOrder?: (string | number | [number, number])[];
  /** Pin this many leading columns (default: the columns marked `pinned`). Works with getColumn tables too. */
  pinnedColumns?: number;
  /** Pin this many trailing columns to the right edge (default: the columns marked `pinned: 'right'`). */
  pinnedColumnsRight?: number;

  // Grid-wide hooks (columns can override them)
  format?(value: V, ctx: CellContext<V> | null): string;
  cellClass?(value: V, ctx: CellContext<V> | null): CellClassResult;
  rowClass?(row: number): string | undefined;
  renderCell?: Renderer<CellContext<V>>;
  renderHeader?: Renderer<HeaderContext>;
  /** Draws the empty state (no rows, or none matching the filter). */
  renderEmpty?: Renderer<EmptyContext>;

  // Events
  /**
   * The user sorted or filtered (`part` says which). Uncontrolled: reported once applied. Controlled (that
   * part is in `query`): the query the user asked for, to pass back as `query`.
   */
  onQueryChange?(query: Query, part: QueryPart): void;
  onSelectionChange?(info: SelectionInfo): void;
  onCopy?(info: CopyInfo): void;
  onColumnResize?(info: ColumnResizeInfo): void;
  /** A column was dragged to another place: the new order, in the same form as `columnOrder`. */
  onColumnOrderChange?(order: (string | number | [number, number])[]): void;
  onRowSelectionChange?(selection: RowSelection): void;
  onCellClick?(e: CellEvent<V>): void;
  onCellDoubleClick?(e: CellEvent<V>): void;
  /** Right click or the context-menu key on a cell. Call e.event.preventDefault() to show your own menu. */
  onCellContextMenu?(e: CellEvent<V>): void;
  onViewChange?(info: ViewChangeInfo): void;
  onError?(error: unknown, context: ErrorContext): void;
  onReady?(grid: Grid): void;

  /** Rarely needed tuning: data block size, shortcut modifier. */
  advanced?: AdvancedOptions;

}

// ------------------------------------------------------------------ grid state

export interface VisibleRange {
  firstRow: number;
  lastRow: number;
  firstCol: number;
  lastCol: number;
}

export interface PivotLevel {
  name: string;
  collapsible: boolean;
}

export interface PivotLevels {
  rows: PivotLevel[];
  cols: PivotLevel[];
}

/** Render and cache counters, for profiling (grid.stats()). The shape may grow in later releases. */
export interface GridStats {
  renders: number;
  renderMsEma: number;
  /** Slowest frame since the last stats() call. */
  renderMsMax: number;
  rowWrites: number;
  cellWrites: number;
  cache: CacheStats & { cached: number; inflight: number; queued: number };
  /** Merged cells set from code (setMerges) and reported by the data source. */
  merges: { code: number; server: number };
  /** How much the scrollbars are scaled down: 1 = exact; above 1 when the grid is taller or wider than a browser can scroll. */
  scrollScale: { x: number; y: number };
}

export interface CacheStats {
  requests: number;
  gatherRequests: number;
  gatherUnits: number;
  cellsFetched: number;
  aborted: number;
  errors: number;
  lastMs: number;
}
