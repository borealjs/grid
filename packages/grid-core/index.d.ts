// Type definitions for @borealjs/grid-core

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

/** A row filter on a column (by source index or key) or a pivot row dimension (`level`). */
export type FilterItem = FilterCondition & ({ column: number; key?: string } | { key: string; column?: number } | { level: number });

/** Which columns are shown: on column groups (tables, level 0) or column dimensions (pivots). */
export type ColumnFilterItem = FilterCondition & { level: number };

export interface Query {
  sort: SortItem[];
  filter: FilterItem[];
  columnFilter: ColumnFilterItem[];
}

export const EMPTY_QUERY: Readonly<Query>;

// ------------------------------------------------------------------ data source

/** A rectangle of cells: rows are positions in the sorted / filtered result, columns are column indexes. */
export interface CellRect {
  row: number;
  col: number;
  rowCount: number;
  colCount: number;
}

/** A merged cell: rows and columns as in CellRect. */
export interface Merge {
  r0: number;
  c0: number;
  nr: number;
  nc: number;
  label?: string;
}

/** Values of one rect: rows of values (`[[a, b], [c, d]]`) or one row-major array (`[a, b, c, d]`). */
export type RectValues<V = unknown> = V[][] | V[];

export type CellsResult<V = unknown> = RectValues<V>[] | { cells: RectValues<V>[]; merges?: Merge[] };

export interface TableLayout {
  type?: 'table';
  /** Rows matching the query's filter. */
  rowCount: number;
  /** Rows without any filter (for "filtered from" texts). */
  totalRowCount?: number;
  columnCount?: number;
  /** Largest table a multi-column sort / a filter may be asked for (the grid refuses beyond). */
  maxSortRows?: number;
  maxFilterRows?: number;
  [extra: string]: unknown;
}

/** Hierarchical axis (pivot rows or columns). */
export interface TreeSpec {
  levels: { name: string; subtotal?: boolean; subtotalSize?: number; collapsible?: boolean }[];
  leafName: string;
  leafSize: number;
  roots: number;
  /** Per level, the number of children of each group. */
  fanout: number[][];
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

/**
 * Where the data comes from. Only getCells is required. The grid asks only for what is on screen; every
 * call gets an AbortSignal (pass it to fetch so requests that are no longer needed are cancelled).
 */
export interface DataSource<V = unknown> {
  /** Cells of one or more rects. */
  getCells(request: { rects: CellRect[]; query: Query; signal?: AbortSignal }): Promise<CellsResult<V>> | CellsResult<V>;
  /**
   * Row count (tables) or the row/column trees (pivots) for a query. Needed for filtering and pivots.
   * A slow sort or filter may report how far it is with onProgress; the grid shows it with a Cancel button,
   * and cancelling aborts `signal`.
   */
  getLayout?(request: { query: Query; signal?: AbortSignal; onProgress?(progress: Progress): void }): Promise<Layout> | Layout;
  /** Header labels for very large axes (pivot groups, column titles not given in column definitions). */
  getLabels?(request: { axis: 'rows' | 'cols'; level: number; start: number; count: number; query: Query; signal?: AbortSignal }): Promise<(string | null)[]> | (string | null)[];
  /** Distinct values for value-list filters (first `limit` matching `search`). */
  getFilterValues?(request: FilterValuesRequest): Promise<FilterValuesResult> | FilterValuesResult;
  /** In-memory sources: the record at a position of the sorted / filtered view (gives cells ctx.row). */
  rowAt?(position: number, query: Query): unknown;
  /** Rects per getCells call (default 400; 1 = one rect per call). */
  maxRectsPerRequest?: number;
  /** Cells per getCells call (default 20,000). */
  maxCellsPerRequest?: number;
}

// ------------------------------------------------------------------ columns and hooks

export interface CellContext<V = unknown> {
  /** Visible row / column index. */
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

export interface ColumnDef<V = unknown> {
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
  /** Group name for the column chooser (column filter level 0). */
  group?: string;
  filter?: FilterKind;
  /** Value -> text shown in the cell (fastest way to customize a cell). */
  format?(value: V, ctx: CellContext<V> | null): string;
  /** Extra CSS class for a cell from its value. */
  cellClass?(value: V, ctx: CellContext<V> | null): string | undefined | null | false;
  className?: string;
  headerClass?: string;
  renderCell?: Renderer<CellContext<V>>;
  renderHeader?: Renderer<HeaderContext>;
  /** In-memory source: read the value from a row (default row[key]). */
  value?(row: any): V;
  /** In-memory source: compare two values for sorting. */
  compare?(a: V, b: V): number;
}

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
  columns: string;
  applying: string;
  cancel: string;
  /** A sort or filter that takes a while: "Filtering… Checking rows · 42% · 7 s". */
  working(what: 'sort' | 'filter' | 'columns', progress: Progress | null, seconds: number): string;
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

export const DEFAULT_MESSAGES: Messages;

// ------------------------------------------------------------------ events

export interface SelectionRange { r0: number; c0: number; r1: number; c1: number }

export interface Selection {
  active: { r: number; c: number };
  ranges: SelectionRange[];
}

export interface SelectionInfo {
  active: { r: number; c: number };
  /** Text of the active cell (undefined while loading). */
  text: string | undefined;
  ranges: number;
  rows: number;
  cols: number;
  cells: number;
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
}

export interface ViewChangeInfo {
  pending?: boolean;
  /** While pending: how far the data source says it is. */
  progress?: Progress;
  ok?: boolean;
  /** The user (or grid.cancel()) stopped it. */
  cancelled?: boolean;
  what: 'sort' | 'filter' | 'columns';
  reason?: string;
  rows?: number;
  cols?: number;
  totalRows?: number;
  sort?: string;
  filter?: string;
  droppedSorts?: number;
}

// ------------------------------------------------------------------ options

/** What a sortable rule is asked about: a column, or a pivot row level. */
export type SortTarget = { axis: 'cols'; column: number; key?: string } | { axis: 'rows'; level: number };
/** What a filterable rule is asked about: a column, a pivot row level, or a column level (pivot dimensions; the column chooser is level 0). */
export type FilterTarget = SortTarget | { axis: 'cols'; level: number };

export interface GridOptions<V = unknown> {
  dataSource: DataSource<V>;
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
  rowHeader?: false | { width?: number; title?: string; label?(row: number): string };
  /** Pivot row header column widths. */
  rowHeaderWidths?: number[];
  /** Column chooser on the corner (choose columns by `group`). Default: on when columns have groups. */
  columnChooser?: boolean;
  columnGroups?: string[];
  theme?: 'auto' | 'light' | 'dark';
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
  selection?: 'multi' | 'single' | 'none';
  copy?: boolean;
  keyboard?: boolean;
  /** Built-in notice for refused or failed sorts and filters (turn off if you show onViewChange yourself). */
  notices?: boolean;

  // Query: initial (uncontrolled) or the current value (with `controlled`)
  sort?: SortItem[];
  filter?: FilterItem[];
  columnFilter?: ColumnFilterItem[];
  defaultSort?: SortItem[];
  defaultFilter?: FilterItem[];
  defaultColumnFilter?: ColumnFilterItem[];
  /** Controlled parts only report user changes (on…Change); apply them with setSort etc. */
  controlled?: { sort?: boolean; filter?: boolean; columnFilter?: boolean };

  // Grid-wide hooks (columns can override them)
  format?(value: V, ctx: CellContext<V> | null): string;
  cellClass?(value: V, ctx: CellContext<V> | null): string | undefined | null | false;
  rowClass?(row: number): string | undefined;
  renderCell?: Renderer<CellContext<V>>;
  renderHeader?: Renderer<HeaderContext>;
  /** Draws the empty state (no rows, or none matching the filter). */
  renderEmpty?: Renderer<{ filtered: boolean }>;

  // Events
  onSortChange?(sort: SortItem[]): void;
  onFilterChange?(filter: FilterItem[]): void;
  onColumnFilterChange?(columnFilter: ColumnFilterItem[]): void;
  onSelectionChange?(info: SelectionInfo): void;
  onCopy?(info: CopyInfo): void;
  onColumnResize?(info: { column: number; key?: string; width: number }): void;
  onViewChange?(info: ViewChangeInfo): void;
  onError?(error: unknown, context: { kind: 'layout' | 'cells' | 'labels' }): void;
  onReady?(grid: Grid): void;

  /** Low-level: a custom layout model. May change in any release. */
  model?: unknown;
}

// ------------------------------------------------------------------ grid

export declare class Grid {
  /** Resolves when the first layout is in and the grid is drawn. */
  ready: Promise<void>;
  readonly options: GridOptions;
  /** Low-level access to the grid's internals. May change in any release. */
  readonly engine: VirtualGrid | undefined;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly visibleRange: { firstRow: number; lastRow: number; firstCol: number; lastCol: number } | undefined;
  /** Pivot levels (undefined for tables). */
  readonly levels: { rows: { name: string; collapsible: boolean }[]; cols: { name: string; collapsible: boolean }[] } | undefined;

  setOptions(options: Partial<GridOptions>): Promise<void>;
  rebuild(): Promise<void>;

  getQuery(): Query;
  getSort(): SortItem[];
  getFilter(): FilterItem[];
  getColumnFilter(): ColumnFilterItem[];
  setSort(sort: SortItem[]): Promise<boolean>;
  setFilter(filter: FilterItem[]): Promise<boolean>;
  setColumnFilter(columnFilter: ColumnFilterItem[]): Promise<boolean>;
  toggleSort(column: number | string, additive?: boolean): Promise<boolean>;
  openFilter(target: number | string | { level: number } | { columnLevel: number }): void;
  closeFilter(): void;
  /** Stop a sort or filter that is still being applied. Returns false when none is running. */
  cancel(): boolean;

  refresh(): Promise<void>;
  repaint(): void;
  setMerges(merges: Merge[]): void;

  scrollToCell(row: number, col?: number): void;
  getSelection(): Selection | undefined;
  setSelection(selection: { active?: { r: number; c: number }; ranges?: SelectionRange[] }): void;
  selectAll(): void;
  selectionInfo(): SelectionInfo | undefined;
  copySelection(): Promise<CopyInfo>;
  cellValue(row: number, col: number): unknown;
  cellText(row: number, col: number): string | undefined;
  setColumnWidth(col: number, width: number): void;
  focus(): void;

  toggleGroup(axis: 'rows' | 'cols', level: number, group: number): void;
  showLevel(axis: 'rows' | 'cols', level: number): void;
  expandAll(axis: 'rows' | 'cols'): void;

  stats(): unknown;
  destroy(): void;
}

export function createGrid<V = unknown>(host: HTMLElement, options: GridOptions<V>): Grid;

// ------------------------------------------------------------------ sources

export interface ArraySource<R = any> extends DataSource {
  readonly rows: R[];
  /** Replace the rows; then call grid.refresh(). */
  setRows(rows: R[]): void;
}

export function createArraySource<R = any>(
  rows: R[],
  options?: {
    columns?: (ColumnDef | string | number)[];
    filterFns?: Record<string, (value: unknown, conditionValue: unknown, row: R) => boolean>;
    compare?(a: unknown, b: unknown): number;
  },
): ArraySource<R>;

export function createHttpSource(options?: {
  baseUrl?: string;
  params?: Record<string, string | number | boolean | undefined | null>;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}): DataSource<string>;

export function compareValues(a: unknown, b: unknown): number;
export function defaultFormat(value: unknown): string;

// ------------------------------------------------------------------ low-level pieces (may change in any release)

export declare class VirtualGrid {
  constructor(host: HTMLElement, options: Record<string, unknown>);
  [member: string]: any;
}
export declare class UniformAxis {
  constructor(count: number, size: number);
  count: number;
  total: number;
  offsetOf(i: number): number;
  sizeOf(i: number): number;
  indexAt(px: number): number;
}
export declare class ResizableAxis {
  constructor(base: unknown);
  [member: string]: any;
}
export declare class TreeAxis {
  constructor(spec: TreeSpec);
  [member: string]: any;
}
export declare class BlockCache {
  constructor(options: Record<string, unknown>);
  [member: string]: any;
}
export function createTableModel(options: GridOptions, layout: TableLayout, source: DataSource, initial?: { filter?: string; colfilter?: string }): unknown;
export function createPivotModel(layout: PivotLayout, source: DataSource, options?: Partial<GridOptions>, initial?: { colfilter?: string }): unknown;
