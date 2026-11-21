// createGrid(host, options): the public entry point. Builds the model (table or pivot) from the data
// source's layout, wires the data source into the engine, and exposes a small, stable API in the
// public query format. Options can change later with setOptions (callbacks are always the latest ones).

import { GridEngine, type BlockPayload, type GatherPayload } from './engine/engine.js';
import { createPivotModel } from './model/pivot.js';
import { createTableModel } from './model/table.js';
import type { GridModel } from './model/types.js';
import {
  columnFilterFromPublic, columnFilterToPublic, filterFromPublic, filterParamOf, filterToPublic, sortFromPublic, sortToPublic, type ViewKey,
} from './query.js';
import type {
  CellRect, CellsResult, ColumnFilterItem, CopyInfo, DataSource, ErrorContext, FilterItem, GridOptions, GridStats, Layout, Merge, PivotLayout,
  PivotLevels, Query, Selection, SelectionInfo, SelectionRange, SortItem, TableLayout, Theme, VisibleRange,
} from './types.js';

type OptionKey = keyof GridOptions;

/** Event callbacks: always called in their latest version, so changing them never rebuilds. */
const CALLBACKS = [
  'onSortChange', 'onFilterChange', 'onColumnFilterChange', 'onSelectionChange', 'onCopy', 'onError', 'onViewChange', 'onColumnResize', 'onReady',
] as const satisfies readonly OptionKey[];
/** Cell / header hooks: changing them redraws (adding or removing one rebuilds). */
const HOOKS = ['format', 'cellClass', 'renderCell', 'renderHeader', 'renderEmpty', 'rowClass'] as const satisfies readonly OptionKey[];
const QUERY_KEYS = ['sort', 'filter', 'columnFilter'] as const satisfies readonly OptionKey[];
/** Options applied in place, without a rebuild. */
const LIVE_KEYS = new Set<OptionKey>([...CALLBACKS, ...HOOKS, ...QUERY_KEYS, 'theme', 'controlled', 'ariaLabel', 'defaultSort', 'defaultFilter', 'defaultColumnFilter']);
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

/** What a rebuild keeps: scroll position and query. */
interface Kept {
  vx: number;
  vy: number;
  query: Query;
}

export class Grid {
  /** Resolves when the first layout is in and the grid is drawn (again after a rebuild). */
  ready: Promise<void>;
  readonly #host: HTMLElement;
  #opts: GridOptions<any>;
  #engine: GridEngine | null = null;
  #destroyed = false;
  #buildSeq = 0;
  #theme: Theme = 'auto';

  constructor(host: HTMLElement, options: GridOptions<any>) {
    if (!host || typeof host.appendChild !== 'function') throw new TypeError('createGrid: the first argument must be an element');
    if (!options?.model && typeof options?.dataSource?.getCells !== 'function') throw new TypeError('createGrid: `dataSource.getCells` is required');
    this.#host = host;
    this.#opts = { ...options };
    this.ready = this.#build();
  }

  /** Low-level access to the engine (models, axes, caches). Undefined until ready. May change in any release. */
  get engine(): GridEngine | undefined { return this.#engine ?? undefined; }

  /** A copy of the current options. */
  get options(): GridOptions { return { ...this.#opts }; }

  async #build(keep?: Kept): Promise<void> {
    const seq = ++this.#buildSeq;
    const o = this.#opts;
    const source: Partial<DataSource> = o.dataSource ?? {};
    const keyIndex = Array.isArray(o.columns) ? new Map(o.columns.map((d, i) => [d.key, i])) : null;
    const colOfKey = (k: string | undefined) => keyIndex?.get(k) ?? -1;
    const keyOf = (c: number) => (Array.isArray(o.columns) ? o.columns[c]?.key : undefined);
    const initial = {
      sort: sortFromPublic(keep?.query.sort ?? o.sort ?? o.defaultSort, colOfKey).slice(0, MAX_SORT_KEYS),
      filter: filterFromPublic(keep?.query.filter ?? o.filter ?? o.defaultFilter, colOfKey),
      columnFilter: columnFilterFromPublic(keep?.query.columnFilter ?? o.columnFilter ?? o.defaultColumnFilter),
    };
    const initialQuery: Query = { sort: sortToPublic(initial.sort, keyOf), filter: filterToPublic(initial.filter, keyOf), columnFilter: columnFilterToPublic(initial.columnFilter) };
    const params = { filter: filterParamOf(initial.filter), colfilter: filterParamOf(initial.columnFilter) };

    let model = o.model as GridModel | undefined;
    if (!model) {
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
      model = isPivotLayout(layout)
        ? createPivotModel(layout, source as DataSource, this.#hookOptions(), params)
        : createTableModel(this.#hookOptions(), layout as TableLayout, source as DataSource, params);
    }
    if (seq !== this.#buildSeq || this.#destroyed) return;

    this.#engine?.destroy();
    this.#theme = THEMES.includes(o.theme as Theme) ? (o.theme as Theme) : 'auto';
    const latest = <K extends OptionKey>(name: K) => (...args: unknown[]) => (this.#opts[name] as ((...a: unknown[]) => unknown) | undefined)?.(...args);
    const getCells = async (rects: CellRect[], query: Query, signal?: AbortSignal) => normalizeCells(await source.getCells!({ rects, query, signal }), rects);
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
      blockRows: o.blockRows ?? 100,
      blockCols: o.blockCols ?? 20,
      maxGatherRects: source.maxRectsPerRequest ?? 400,
      maxGatherCells: source.maxCellsPerRequest ?? 20_000,
      controlled: o.controlled,
      isMac: o.isMac,
      format: o.format && ((v, ctx) => this.#opts.format?.(v, ctx) ?? ''),
      cellClass: o.cellClass && ((v, ctx) => this.#opts.cellClass?.(v, ctx)),
      renderCell: o.renderCell && ((el, ctx) => this.#opts.renderCell?.(el, ctx)),
      renderHeader: o.renderHeader && ((el, ctx) => this.#opts.renderHeader?.(el, ctx)),
      renderEmpty: o.renderEmpty && ((el, ctx) => this.#opts.renderEmpty?.(el, ctx)),
      // The data record behind a row, for cell renderers (in-memory sources can tell; servers usually not).
      rowAt: typeof source.rowAt === 'function' ? (position) => source.rowAt!(position, this.#engine?.query ?? initialQuery) : undefined,
      ...(Object.fromEntries(CALLBACKS.map((n) => [n, latest(n)])) as Pick<GridOptions, (typeof CALLBACKS)[number]>),
      onError: (err, ctx) => this.#error(err, ctx),
      fetchBlock: async ({ r0, c0, nr, nc, signal, query }): Promise<BlockPayload> => {
        const out = await getCells([{ row: r0, col: c0, rowCount: nr, colCount: nc }], query, signal);
        return { cells: out.cells[0], merges: out.merges };
      },
      fetchGather: canGather
        ? ({ rects, signal, query }): Promise<GatherPayload> => getCells(rects.map(([row, col, rowCount, colCount]) => ({ row, col, rowCount, colCount })), query, signal)
        : undefined,
      fetchLabels: async ({ axis, level, from, n, signal, query }) => {
        if (typeof source.getLabels !== 'function') return Array.from({ length: n }, (_, i) => String(from + i + 1));
        const names = await source.getLabels({ axis, level, start: from, count: n, query, signal });
        return names.map((x) => (x === null || x === undefined ? '' : String(x)));
      },
    });
    this.#engine = engine;
    if (keep) engine.scrollToVirtual(keep.vx, keep.vy);
    this.#opts.onReady?.(this);
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
   * redrawn); sort / filter / columnFilter are applied like setSort etc.; theme switches in place;
   * anything structural (dataSource, columns, sizes, feature switches) rebuilds the grid and keeps its
   * scroll position and query.
   */
  setOptions(next: Partial<GridOptions<any>>): Promise<void> {
    const prev = this.#opts;
    const changed = (Object.keys(next) as OptionKey[]).filter((k) => next[k] !== prev[k]);
    if (!changed.length) return Promise.resolve();
    this.#opts = { ...prev, ...next };
    const structural = changed.some((k) => !LIVE_KEYS.has(k));
    const hookPresence = changed.some((k) => (HOOKS as readonly OptionKey[]).includes(k) && typeof prev[k] !== typeof next[k]);
    if (structural || hookPresence || !this.#engine) return this.rebuild();
    const e = this.#engine;
    if (changed.includes('controlled')) e.o.controlled = this.#opts.controlled;
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
    const tasks: Promise<boolean>[] = [];
    if (changed.includes('columnFilter')) tasks.push(this.setColumnFilter(next.columnFilter ?? []));
    if (changed.includes('filter')) tasks.push(this.setFilter(next.filter ?? []));
    if (changed.includes('sort')) tasks.push(this.setSort(next.sort ?? []));
    return Promise.all(tasks).then(() => undefined);
  }

  /** Build again from the current options (keeps the scroll position and the query). */
  rebuild(): Promise<void> {
    const e = this.#engine;
    const keep = e ? { vx: e.vx, vy: e.vy, query: e.getQuery() } : undefined;
    this.ready = this.#build(keep);
    return this.ready;
  }

  // ---------------------------------------------------------------- query

  #colOfKey = (k: string | undefined): number =>
    this.#engine?.model.colOfKey?.(k) ?? (Array.isArray(this.#opts.columns) ? this.#opts.columns.findIndex((d) => d.key === k) : -1);

  getQuery(): Query {
    return this.#engine ? this.#engine.getQuery() : { sort: this.#opts.sort ?? [], filter: this.#opts.filter ?? [], columnFilter: this.#opts.columnFilter ?? [] };
  }

  getSort(): SortItem[] { return this.getQuery().sort; }

  getFilter(): FilterItem[] { return this.getQuery().filter; }

  getColumnFilter(): ColumnFilterItem[] { return this.getQuery().columnFilter; }

  /** Sort: [{ column | key, direction }] or [{ level, direction }] (pivot row dimensions). Resolves true when applied. */
  setSort(sort: SortItem[]): Promise<boolean> {
    if (!this.#engine) return this.ready.then(() => this.setSort(sort));
    return this.#engine.setSort(sortFromPublic(sort, this.#colOfKey));
  }

  /** Row filter: [{ column | key | level, op, … }] (see the query format). Resolves true when applied. */
  setFilter(filter: FilterItem[]): Promise<boolean> {
    if (!this.#engine) return this.ready.then(() => this.setFilter(filter));
    return this.#engine.setFilter(filterFromPublic(filter, this.#colOfKey));
  }

  /** Column filter: [{ level, op, … }] on column groups (tables) or column dimensions (pivots). */
  setColumnFilter(columnFilter: ColumnFilterItem[]): Promise<boolean> {
    if (!this.#engine) return this.ready.then(() => this.setColumnFilter(columnFilter));
    return this.#engine.setColumnDimFilter(columnFilterFromPublic(columnFilter));
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

  /** Drop cached data and load what is visible again (call after the data changed). */
  refresh(): Promise<void> { return this.#engine?.refresh() ?? this.ready; }

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
