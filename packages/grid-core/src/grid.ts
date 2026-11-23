// createGrid(host, options): the public entry point. Builds the model (table or pivot) from the data
// source's layout, wires the data source into the engine, and exposes a small, stable API in the
// public query format. Options can change later with setOptions (callbacks are always the latest ones).

import { GridEngine, type BlockPayload, type ControlledParts, type GatherPayload } from './engine/engine.js';
import { createPivotModel } from './model/pivot.js';
import { createTableModel } from './model/table.js';
import { createRowSource, type RowSource } from './sources/rows.js';
import { createArraySource, type ArraySource } from './sources/array.js';
import type { GridModel } from './model/types.js';
import {
  columnFilterFromPublic, columnFilterToPublic, filterFromPublic, filterParamOf, filterToPublic, sortFromPublic, sortToPublic, type ViewKey,
} from './query.js';
import type {
  CellRect, CellsResult, ColumnDef, CopyInfo, DataSource, ErrorContext, GridOptions, GridStats, Layout, Merge, PivotLayout,
  PivotLevels, Query, QueryPart, RowId, RowSelection, Selection, SelectionInfo, SelectionRange, TableLayout, Theme, VisibleRange,
} from './types.js';

type OptionKey = keyof GridOptions;

/** Event callbacks: always called in their latest version, so changing them never rebuilds. */
const CALLBACKS = [
  'onQueryChange', 'onSelectionChange', 'onCopy', 'onError', 'onViewChange', 'onColumnResize', 'onReady',
  'onRowSelectionChange', 'onCellClick', 'onCellDoubleClick', 'onCellContextMenu', 'onColumnOrderChange',
] as const satisfies readonly OptionKey[];
/** Cell / header hooks: changing them redraws (adding or removing one rebuilds). */
const HOOKS = ['format', 'cellClass', 'renderCell', 'renderHeader', 'renderEmpty', 'rowClass'] as const satisfies readonly OptionKey[];
const QUERY_PARTS = ['columnFilter', 'filter', 'sort'] as const satisfies readonly QueryPart[]; // the order they are applied in
/** Options applied in place, without a rebuild. */
const LIVE_KEYS = new Set<OptionKey>([
  ...CALLBACKS, ...HOOKS, 'query', 'defaultQuery', 'theme', 'ariaLabel', 'selectedRows', 'columnOrder', 'getRowId',
]);
/** The parts of `query` the owner controls: the ones it has. */
const controlledOf = (query: Partial<Query> | undefined): ControlledParts => ({
  sort: query?.sort !== undefined, filter: query?.filter !== undefined, columnFilter: query?.columnFilter !== undefined,
});
const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const THEMES: readonly Theme[] = ['auto', 'light', 'dark'];
const MAX_SORT_KEYS = 4;

/** Rows of a rect as one row-major array: accepts rows ([[...], …]) or an already row-major array. */
function rowMajor(values: unknown, nr: number, nc: number): unknown[] {
  if (!Array.isArray(values)) throw new TypeError('getCells: each rect needs an array of values');
  if (values.length === nr && nr > 0 && Array.isArray(values[0]) && (nc !== 1 || values.length !== nr * nc || values.every(Array.isArray))) {
    const out = new Array<unknown>(nr * nc);
    for (let i = 0; i < nr; i++) {
      const row = (values[i] ?? []) as unknown[];
      for (let j = 0; j < nc; j++) out[i * nc + j] = row[j] ?? null;
    }
    return out;
  }
  return values;
}

/** Splits a getCells result into row-major arrays per rect, and merged cells. */
function normalizeCells(res: CellsResult, rects: CellRect[]): { cells: unknown[][]; merges: Merge[] } {
  const list = Array.isArray(res) ? res : res?.cells;
  if (!Array.isArray(list) || list.length !== rects.length) throw new TypeError(`getCells must return one array per rect (${rects.length} asked)`);
  return { cells: list.map((v, i) => rowMajor(v, rects[i].rowCount, rects[i].colCount)), merges: Array.isArray(res) ? [] : res.merges ?? [] };
}

const isPivotLayout = (layout: Layout): layout is PivotLayout => layout.type === 'pivot' || (!!layout.rows && typeof layout.rows === 'object');

/** Creates a grid in `host` (an element with a size). Returns at once; `grid.ready` resolves when it is drawn. */
export function createGrid<V = unknown>(host: HTMLElement, options: GridOptions<V>): Grid {
  return new Grid(host, options);
}

/** What a rebuild keeps: scroll position, query, column order and checked rows. */
interface Kept {
  vx: number;
  vy: number;
  query: Query;
  columnOrder?: (string | number | [number, number])[];
  rowSelection?: RowSelection;
}

/** Compact order ([first, last] runs and indexes) -> every source index (column lists only: small). */
const expandOrder = (order: (number | [number, number])[]): number[] =>
  order.flatMap((x) => (Array.isArray(x) ? Array.from({ length: x[1] - x[0] + 1 }, (_, i) => x[0] + i) : [x]));

const isRowSource = (s: unknown): s is RowSource => !!s && typeof (s as RowSource).setColumns === 'function' && 'hasColumns' in (s as object);

export class Grid {
  /** Resolves when the first layout is in and the grid is drawn (again after a rebuild). */
  ready: Promise<void>;
  readonly #host: HTMLElement;
  #opts: GridOptions<any>;
  #engine: GridEngine | null = null;
  #destroyed = false;
  #buildSeq = 0;
  #theme: Theme = 'auto';
  #source: Partial<DataSource> = {};
  /** `{ getRows }` sources get a row source around them (kept per object, so its cache survives rebuilds). */
  readonly #wrapped = new WeakMap<object, RowSource>();
  /** `data` given as an array: an in-memory source around it (new arrays go in with setRows). */
  #arrayWrap: { source: ArraySource; columns: unknown } | null = null;
  /** No columns given: the ones the data source took from its rows (fields as keys and titles). */
  #inferred: ColumnDef<any>[] | null = null;

  constructor(host: HTMLElement, options: GridOptions<any>) {
    if (!host || typeof host.appendChild !== 'function') throw new TypeError('createGrid: the first argument must be an element');
    const ds = options?.data as Partial<DataSource> | readonly unknown[] | undefined;
    if (!Array.isArray(ds) && typeof (ds as Partial<DataSource>)?.getCells !== 'function' && typeof (ds as Partial<DataSource>)?.getRows !== 'function') {
      throw new TypeError('createGrid: `data` must be an array of rows or a data source with `getRows` or `getCells`');
    }
    this.#host = host;
    this.#opts = { ...options };
    this.ready = this.#build();
  }

  /** A copy of the current options. */
  get options(): GridOptions { return { ...this.#opts }; }

  async #build(keep?: Kept): Promise<void> {
    const seq = ++this.#buildSeq;
    const o = this.#opts;
    const source = this.#resolveSource();
    this.#source = source;
    this.#inferred = this.#inferColumns(source); // in-memory rows know theirs now; getRows sources after the first page
    const colOfKey = (k: string | undefined) => this.#columnList()?.findIndex((d) => d.key === k) ?? -1;
    const keyOf = (c: number) => this.#columnList()?.[c]?.key;
    const initial = {
      sort: sortFromPublic(keep?.query.sort ?? o.query?.sort ?? o.defaultQuery?.sort, colOfKey).slice(0, MAX_SORT_KEYS),
      filter: filterFromPublic(keep?.query.filter ?? o.query?.filter ?? o.defaultQuery?.filter, colOfKey),
      columnFilter: columnFilterFromPublic(keep?.query.columnFilter ?? o.query?.columnFilter ?? o.defaultQuery?.columnFilter),
    };
    const initialQuery: Query = { sort: sortToPublic(initial.sort, keyOf), filter: filterToPublic(initial.filter, keyOf), columnFilter: columnFilterToPublic(initial.columnFilter) };
    const params = { filter: filterParamOf(initial.filter), colfilter: filterParamOf(initial.columnFilter) };

    let layout = o.layout;
    if (!layout) {
      try {
        layout = typeof source.getLayout === 'function' ? await source.getLayout({ query: initialQuery }) : { rowCount: o.rowCount ?? 0 };
      } catch (err) {
        if (seq === this.#buildSeq && !this.#destroyed) this.#error(err, { kind: 'layout' });
        throw err;
      }
    }
    if (seq !== this.#buildSeq || this.#destroyed) return;
    this.#inferred = this.#inferColumns(source);
    const modelOptions = this.#hookOptions();
    if (this.#inferred) modelOptions.columns = this.#inferred;
    if (keep?.columnOrder) modelOptions.columnOrder = keep.columnOrder;
    const model: GridModel = isPivotLayout(layout)
      ? createPivotModel(layout, source as DataSource, modelOptions, params)
      : createTableModel(modelOptions, layout as TableLayout, source as DataSource, params);
    if (seq !== this.#buildSeq || this.#destroyed) return;

    this.#engine?.destroy();
    this.#theme = THEMES.includes(o.theme as Theme) ? (o.theme as Theme) : 'auto';
    const latest = <K extends OptionKey>(name: K) => (...args: unknown[]) => (this.#opts[name] as ((...a: unknown[]) => unknown) | undefined)?.(...args);
    const getCells = async (rects: CellRect[], query: Query, signal?: AbortSignal) => normalizeCells(await source.getCells!({ rects, query, signal }), rects);
    // Row ids: getRowId, or (in-memory rows) the row object itself.
    const inMemory = Array.isArray((source as { rows?: unknown }).rows) && typeof source.rowAt === 'function';
    const getRowId = typeof o.getRowId === 'function' ? (row: unknown) => this.#opts.getRowId!(row) : inMemory ? (row: unknown) => row as RowId : undefined;
    const currentQuery = () => this.#engine?.query ?? initialQuery;
    const keyOfSource = (s: number) => this.#engine?.model.keyOf?.(s) ?? keyOf(s) ?? s;
    // Column lists report their order as keys; very wide tables keep the compact form.
    const publicOrder = (order: (number | [number, number])[]) => (this.#columnList() ? expandOrder(order).map(keyOfSource) : order);
    const canGather = (source.maxRectsPerRequest ?? 400) > 1;
    const engine = new GridEngine(this.#host, {
      model,
      initial,
      api: this,
      theme: this.#theme,
      ariaLabel: o.ariaLabel,
      messages: o.messages,
      // A function decides per column or level (see GridOptions.sortable); it always reads the latest option.
      sortable: typeof o.sortable === 'function' ? (target) => (this.#opts.sortable as (t: typeof target) => boolean)?.(target) : o.sortable !== false,
      filterable: typeof o.filterable === 'function' ? (target) => (this.#opts.filterable as (t: typeof target) => boolean)?.(target) : o.filterable !== false,
      resizable: o.resizable !== false,
      multiSort: o.multiSort !== false,
      expandable: o.expandable !== false,
      selection: o.selection ?? 'multi',
      copy: o.copy !== false,
      keyboard: o.keyboard !== false,
      notices: o.notices !== false,
      minColWidth: o.minColumnWidth ?? 48,
      blockRows: o.advanced?.blockRows ?? 100,
      blockCols: o.advanced?.blockCols ?? 20,
      maxGatherRects: source.maxRectsPerRequest ?? 400,
      maxGatherCells: source.maxCellsPerRequest ?? 20_000,
      controlled: controlledOf(o.query),
      isMac: o.advanced?.isMac,
      format: o.format && ((v, ctx) => this.#opts.format?.(v, ctx) ?? ''),
      cellClass: o.cellClass && ((v, ctx) => this.#opts.cellClass?.(v, ctx)),
      renderCell: o.renderCell && ((el, ctx) => this.#opts.renderCell?.(el, ctx)),
      renderHeader: o.renderHeader && ((el, ctx) => this.#opts.renderHeader?.(el, ctx)),
      renderEmpty: o.renderEmpty && ((el, ctx) => this.#opts.renderEmpty?.(el, ctx)),
      // The data record behind a row, for cell renderers (in-memory sources can tell; servers usually not).
      rowAt: typeof source.rowAt === 'function' ? (position) => source.rowAt!(position, currentQuery()) : undefined,
      // A row's id: getRowId on its record, or (getCells sources whose server sends ids) the source's own.
      rowId: getRowId && typeof source.rowAt === 'function'
        ? (position) => {
          const row = source.rowAt!(position, currentQuery());
          return row === undefined || row === null ? undefined : getRowId(row);
        }
        : typeof source.rowIdAt === 'function' ? (position) => source.rowIdAt!(position, currentQuery()) : undefined,
      findRow: typeof source.indexOfRow === 'function' ? (id, query) => source.indexOfRow!(id, query, getRowId ?? ((row: unknown) => row as RowId)) : undefined,
      rowSelection: !!o.rowSelection,
      hasHandler: (name) => typeof this.#opts[name] === 'function',
      ...(Object.fromEntries(CALLBACKS.map((n) => [n, latest(n)])) as Pick<GridOptions, (typeof CALLBACKS)[number]>),
      onError: (err, ctx) => this.#error(err, ctx),
      onColumnOrderChange: (order) => this.#opts.onColumnOrderChange?.(publicOrder(order)),
      fetchBlock: async ({ r0, c0, nr, nc, signal, query }): Promise<BlockPayload> => {
        const out = await getCells([{ row: r0, col: c0, rowCount: nr, colCount: nc }], query, signal);
        return { cells: out.cells[0], merges: out.merges };
      },
      fetchGather: canGather
        ? ({ rects, signal, query }): Promise<GatherPayload> => getCells(rects.map(([row, col, rowCount, colCount]) => ({ row, col, rowCount, colCount })), query, signal)
        : undefined,
      fetchColumns: typeof source.getColumns === 'function'
        ? async ({ from, n, signal, query }) => source.getColumns!({ start: from, count: n, query, signal })
        : undefined,
      fetchLabels: async ({ axis, level, from, n, signal, query }) => {
        if (typeof source.getLabels !== 'function') return Array.from({ length: n }, (_, i) => String(from + i + 1));
        const names = await source.getLabels({ axis, level, start: from, count: n, query, signal });
        return names.map((x) => (x === null || x === undefined ? '' : String(x)));
      },
    });
    this.#engine = engine;
    const checked = keep?.rowSelection ?? o.selectedRows;
    if (checked) engine.setRowSelection(checked);
    if (keep) engine.scrollToVirtual(keep.vx, keep.vy);
    this.#opts.onReady?.(this);
  }

  /**
   * The data source to use: an array gets an in-memory source around it, and `{ getRows }` a row source that
   * reads cells by column key.
   */
  #resolveSource(): Partial<DataSource> {
    const o = this.#opts;
    if (Array.isArray(o.data)) {
      const w = this.#arrayWrap;
      if (w && w.columns === o.columns) {
        if (w.source.rows !== o.data) w.source.setRows(o.data as unknown[]);
        return w.source;
      }
      const source = createArraySource(o.data as unknown[], { columns: Array.isArray(o.columns) ? (o.columns as never) : undefined });
      this.#arrayWrap = { source, columns: o.columns };
      return source;
    }
    const src = o.data as Partial<DataSource> | undefined;
    if (!src) return {};
    // No columns at all: the row source takes them from the first row it loads.
    const given = Array.isArray(o.columns) || typeof o.getColumn === 'function';
    const columns = !given ? undefined : Array.isArray(o.columns) ? o.columns : (i: number) => o.getColumn?.(i) ?? {};
    if (typeof src.getCells === 'function') {
      if (isRowSource(src) && !src.hasColumns) src.setColumns(columns);
      return src;
    }
    if (typeof src.getRows !== 'function') return src;
    let wrapped = this.#wrapped.get(src);
    if (!wrapped) {
      wrapped = createRowSource({
        pageSize: src.pageSize,
        maxPages: src.maxPages,
        getRows: (req) => src.getRows!(req),
        getFilterValues: typeof src.getFilterValues === 'function' ? (req) => src.getFilterValues!(req) : undefined,
        indexOfRow: typeof src.indexOfRow === 'function'
          ? (id, query) => src.indexOfRow!(id, query, (row) => this.#opts.getRowId?.(row) as RowId)
          : undefined,
      });
      this.#wrapped.set(src, wrapped);
    }
    wrapped.setColumns(columns);
    return wrapped;
  }

  #error(err: unknown, ctx: ErrorContext): void {
    if (this.#opts.onError) this.#opts.onError(err, ctx);
    else console.warn(`@borealjs/grid-core: ${ctx?.kind ?? 'data'} request failed:`, err);
  }

  /** Options for the model, with hooks that read through to the latest functions (changing them needs no rebuild). */
  #hookOptions(): GridOptions<any> {
    const o = this.#opts;
    const out: Record<string, unknown> = { ...o };
    for (const name of HOOKS) {
      if (typeof o[name] === 'function') out[name] = (...args: unknown[]) => (this.#opts[name] as ((...a: unknown[]) => unknown) | undefined)?.(...args);
    }
    return out as unknown as GridOptions<any>;
  }

  // ---------------------------------------------------------------- options

  /**
   * Change options after creation. Callbacks and render/format functions take effect at once (cells are
   * redrawn); `query` is applied like setQuery; a new `data` array goes in place (same columns); theme
   * switches in place; anything structural (the data source, columns, sizes, feature switches) rebuilds the
   * grid and keeps its scroll position and query.
   */
  setOptions(next: Partial<GridOptions<any>>): Promise<void> {
    const prev = this.#opts;
    const changed = (Object.keys(next) as OptionKey[]).filter((k) => next[k] !== prev[k]);
    if (!changed.length) return Promise.resolve();
    this.#opts = { ...prev, ...next };
    // New rows for in-memory data: keep scroll, sort and filter, reload what is visible.
    const newRows = changed.includes('data') && Array.isArray(prev.data) && Array.isArray(next.data) && !changed.includes('columns');
    if (newRows && this.#engine) {
      const rest = changed.filter((k) => k !== 'data');
      this.#resolveSource();
      const refreshed = this.refresh();
      return rest.length ? Promise.all([refreshed, this.setOptions(Object.fromEntries(rest.map((k) => [k, next[k]])))]).then(() => undefined) : refreshed;
    }
    const structural = changed.some((k) => !LIVE_KEYS.has(k));
    const hookPresence = changed.some((k) => (HOOKS as readonly OptionKey[]).includes(k) && typeof prev[k] !== typeof next[k]);
    const idPresence = changed.includes('getRowId') && typeof prev.getRowId !== typeof next.getRowId;
    if (structural || hookPresence || idPresence || !this.#engine) return this.rebuild();
    const e = this.#engine;
    if (changed.includes('query')) e.o.controlled = controlledOf(this.#opts.query);
    if (changed.includes('ariaLabel')) {
      e.o.ariaLabel = next.ariaLabel;
      if (next.ariaLabel) e.scroller.setAttribute('aria-label', next.ariaLabel);
      else e.scroller.removeAttribute('aria-label');
    }
    if (changed.includes('theme')) {
      const theme = THEMES.includes(next.theme as Theme) ? (next.theme as Theme) : 'auto';
      this.#host.classList.replace(`vg-${this.#theme}`, `vg-${theme}`);
      this.#theme = theme;
      e.o.theme = theme;
    }
    if (changed.some((k) => (HOOKS as readonly OptionKey[]).includes(k))) e.repaint();
    if (changed.includes('selectedRows') && next.selectedRows) e.setRowSelection(next.selectedRows);
    if (changed.includes('columnOrder') && Array.isArray(next.columnOrder)) e.setColumnOrder(next.columnOrder);
    // Controlled query: apply the parts that differ from what the grid shows.
    if (changed.includes('query') && next.query) {
      const current = e.getQuery();
      const parts = Object.fromEntries(QUERY_PARTS.filter((k) => next.query![k] !== undefined && !sameJson(next.query![k], current[k])).map((k) => [k, next.query![k]]));
      if (Object.keys(parts).length) return this.setQuery(parts).then(() => undefined);
    }
    return Promise.resolve();
  }

  /** Build again from the current options (keeps the scroll position and the query). */
  rebuild(): Promise<void> {
    const e = this.#engine;
    const keep = e ? { vx: e.vx, vy: e.vy, query: e.getQuery(), columnOrder: this.getColumnOrder(), rowSelection: e.getRowSelection() } : undefined;
    this.ready = this.#build(keep);
    return this.ready;
  }

  // ---------------------------------------------------------------- query

  #colOfKey = (k: string | undefined): number =>
    this.#engine?.model.colOfKey?.(k) ?? this.#columnList()?.findIndex((d) => d.key === k) ?? -1;

  /** The sort, row filter and column filter in effect. */
  getQuery(): Query {
    if (this.#engine) return this.#engine.getQuery();
    const q = { ...this.#opts.defaultQuery, ...this.#opts.query };
    return { sort: q.sort ?? [], filter: q.filter ?? [], columnFilter: q.columnFilter ?? [] };
  }

  /**
   * Change the query: the parts given (sort, filter, columnFilter) replace the current ones, the others stay.
   * Resolves true when all of them were applied (false if one was refused, failed or cancelled).
   */
  setQuery(query: Partial<Query>): Promise<boolean> {
    const e = this.#engine;
    if (!e) return this.ready.then(() => this.setQuery(query));
    const runs: Promise<boolean>[] = [];
    if (query.columnFilter !== undefined) runs.push(e.setColumnDimFilter(columnFilterFromPublic(query.columnFilter)));
    if (query.filter !== undefined) runs.push(e.setFilter(filterFromPublic(query.filter, this.#colOfKey)));
    if (query.sort !== undefined) runs.push(e.setSort(sortFromPublic(query.sort, this.#colOfKey)));
    return Promise.all(runs).then((oks) => oks.every(Boolean));
  }

  /** Same as a click on a column's sort control (column: source index or key). */
  toggleSort(column: number | string, additive = false): Promise<boolean> {
    const col = typeof column === 'string' ? this.#colOfKey(column) : column;
    return this.#engine?.toggleSort({ col }, additive) ?? Promise.resolve(false);
  }

  /** Open the filter dialog of a column (source index or key), a pivot row dimension ({ level }) or a column level ({ columnLevel }). */
  openFilter(target: number | string | { level: number } | { columnLevel: number }): void {
    if (!this.#engine) return;
    let key: ViewKey;
    if (typeof target === 'object') key = 'columnLevel' in target ? { cdim: target.columnLevel } : { dim: target.level };
    else key = { col: typeof target === 'string' ? this.#colOfKey(target) : target };
    void this.#engine.openFilter(key);
  }

  closeFilter(): void { this.#engine?.closeFilter(); }

  /** Stop a sort or filter that is still being applied. Returns false when none is running. */
  cancel(): boolean { return this.#engine?.cancelView() ?? false; }

  // ---------------------------------------------------------------- data and drawing

  /**
   * Drop cached data and load what is visible again (call after the data changed). With row ids the
   * selection stays on its row.
   */
  refresh(): Promise<void> {
    const e = this.#engine;
    if (!e) return this.ready;
    // Columns taken from the rows: new rows with other fields need new columns.
    const next = this.#inferColumns(this.#source);
    if (JSON.stringify(next) !== JSON.stringify(this.#inferred)) return this.rebuild();
    const snap = e.rowSnapshot();
    this.#source.clearCache?.();
    return e.refresh(snap);
  }

  /** The column list in use: the one given, or the one taken from the rows. */
  #columnList(): ColumnDef<any>[] | undefined {
    return Array.isArray(this.#opts.columns) ? this.#opts.columns : this.#inferred ?? undefined;
  }

  /** Columns the data source took from its rows, when the grid was given none (no columns, getColumn or columnCount). */
  #inferColumns(source: Partial<DataSource>): ColumnDef<any>[] | null {
    const o = this.#opts;
    if (Array.isArray(o.columns) || typeof o.getColumn === 'function' || o.columnCount !== undefined) return null;
    return (source as { inferredColumns?(): ColumnDef<any>[] | null }).inferredColumns?.() ?? null;
  }

  /** The record behind a visible row, when the data source has it (in-memory rows, getRows pages loaded). */
  getRow(rowIndex: number): unknown {
    const e = this.#engine;
    if (!e || typeof this.#source.rowAt !== 'function' || rowIndex < 0 || rowIndex >= e.rows.count) return undefined;
    return this.#source.rowAt(e.rowSource(rowIndex), e.query);
  }

  /** Checked rows (rowSelection): steps, the last one covering a row decides (see RowSelection). */
  getRowSelection(): RowSelection { return this.#engine?.getRowSelection() ?? { checks: [] }; }

  /** How many rows are checked, when it can be told without asking the server (undefined otherwise). */
  checkedCount(): number | undefined { return this.#engine?.checkedCount(); }

  setRowSelection(selection: RowSelection): void { this.#engine?.setRowSelection(selection); }

  /** Column order: keys (or source indexes) for column lists; compact runs for getColumn tables (see columnOrder). */
  getColumnOrder(): (string | number | [number, number])[] {
    const e = this.#engine;
    const order = e?.model.columnOrder?.();
    if (!order) return [];
    return this.#columnList() ? expandOrder(order).map((s) => e!.model.keyOf?.(s) ?? s) : order;
  }

  setColumnOrder(order: (string | number | [number, number])[]): void {
    this.#engine?.setColumnOrder(order);
  }

  /** Redraw cells and headers without reloading data. */
  repaint(): void { this.#engine?.repaint(); }

  /** Merged cells set from code: [{ r0, c0, nr, nc, label? }] in source coordinates. */
  setMerges(merges: Merge[]): void { this.#engine?.setMerges(merges); }

  // ---------------------------------------------------------------- navigation and selection

  scrollToCell(row: number, col = 0): void { this.#engine?.scrollToCell(row, col); }

  /** Visible window: { firstRow, lastRow, firstCol, lastCol } (or undefined before the first frame). */
  get visibleRange(): VisibleRange | undefined {
    const v = this.#engine?.view;
    return v ? { firstRow: v.firstRow, lastRow: v.lastRow, firstCol: v.firstCol, lastCol: v.lastCol } : undefined;
  }

  get rowCount(): number { return this.#engine?.rows.count ?? 0; }

  get columnCount(): number { return this.#engine?.cols.count ?? 0; }

  getSelection(): Selection | undefined { return this.#engine?.getSelection(); }

  setSelection(selection: { active?: { r: number; c: number }; ranges?: SelectionRange[] }): void { this.#engine?.setSelection(selection); }

  selectAll(): void { this.#engine?.selectAll(); }

  selectionInfo(): SelectionInfo | undefined { return this.#engine?.selectionInfo(); }

  copySelection(): Promise<CopyInfo> {
    return this.#engine?.copySelection() ?? Promise.resolve({ ok: false, reason: 'not ready', cells: 0, ranges: 0, rows: 0, cols: 0, fetched: 0, ms: 0 });
  }

  cellValue(row: number, col: number): unknown { return this.#engine?.cellValue(row, col); }

  cellText(row: number, col: number): string | undefined { return this.#engine?.cellText(row, col); }

  setColumnWidth(col: number, width: number): void { this.#engine?.setColumnWidth(col, width); }

  focus(): void { this.#engine?.scroller.focus({ preventScroll: true }); }

  // ---------------------------------------------------------------- pivot groups

  /** Pivot levels: { rows: [{ name, collapsible }], cols: [...] } (undefined for tables). */
  get levels(): PivotLevels | undefined { return this.#engine?.model.levels; }

  toggleGroup(axis: 'rows' | 'cols', level: number, group: number): void { this.#engine?.toggleGroup(axis, level, group); }

  /** Show `axis` down to `level` (deeper levels collapsed). */
  showLevel(axis: 'rows' | 'cols', level: number): void {
    const e = this.#engine;
    const model = e?.model;
    if (model?.showLevel) e!.restructure(axis, () => model.showLevel!(axis, level));
  }

  expandAll(axis: 'rows' | 'cols'): void {
    const e = this.#engine;
    const model = e?.model;
    if (model?.expandAll) e!.restructure(axis, () => model.expandAll!(axis));
  }

  /** Render and cache statistics (undefined until ready). */
  stats(): GridStats | undefined { return this.#engine?.takeStats(); }

  destroy(): void {
    this.#destroyed = true;
    this.#buildSeq++;
    this.#engine?.destroy();
    this.#engine = null;
  }
}
