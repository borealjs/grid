// createGrid(host, options): the public entry point. Builds the model (table or pivot) from the data
// source's layout, wires the data source into the engine, and exposes a small, stable API in the
// public query format. Options can change later with setOptions (callbacks are always the latest ones).

import { VirtualGrid, sortParamOf, filterParamOf } from './grid.js';
import { createTableModel, createPivotModel } from './layouts.js';
import { sortFromPublic, filterFromPublic, columnFilterFromPublic, sortToPublic, filterToPublic, columnFilterToPublic } from './query.js';

const CALLBACKS = ['onSortChange', 'onFilterChange', 'onColumnFilterChange', 'onSelectionChange', 'onCopy', 'onError', 'onViewChange', 'onColumnResize', 'onReady'];
const HOOKS = ['format', 'cellClass', 'renderCell', 'renderHeader', 'renderEmpty', 'rowClass'];
const QUERY_KEYS = ['sort', 'filter', 'columnFilter'];
const THEMES = ['auto', 'light', 'dark'];

/** Rows of a rect as one row-major array: accepts rows ([[...], …]) or an already row-major array. */
function rowMajor(values, nr, nc) {
  if (!Array.isArray(values)) throw new TypeError('getCells: each rect needs an array of values');
  if (values.length === nr && nr > 0 && Array.isArray(values[0]) && (nc !== 1 || values.length !== nr * nc || values.every(Array.isArray))) {
    const out = new Array(nr * nc);
    for (let i = 0; i < nr; i++) {
      const row = values[i] ?? [];
      for (let j = 0; j < nc; j++) out[i * nc + j] = row[j] ?? null;
    }
    return out;
  }
  return values;
}

/** Splits a getCells result into row-major arrays per rect, and merged cells. */
function normalizeCells(res, rects) {
  const list = Array.isArray(res) ? res : res?.cells;
  if (!Array.isArray(list) || list.length !== rects.length) throw new TypeError(`getCells must return one array per rect (${rects.length} asked)`);
  return { cells: list.map((v, i) => rowMajor(v, rects[i].rowCount, rects[i].colCount)), merges: Array.isArray(res) ? [] : res.merges ?? [] };
}

/** Creates a grid in `host` (an element with a size). Returns at once; `grid.ready` resolves when it is drawn. */
export function createGrid(host, options) {
  return new Grid(host, options);
}

export class Grid {
  #host;
  #opts;
  #engine = null;
  #destroyed = false;
  #buildSeq = 0;
  #theme;

  constructor(host, options = {}) {
    if (!host || typeof host.appendChild !== 'function') throw new TypeError('createGrid: the first argument must be an element');
    if (!options.model && typeof options.dataSource?.getCells !== 'function') throw new TypeError('createGrid: `dataSource.getCells` is required');
    this.#host = host;
    this.#opts = { ...options };
    this.ready = this.#build();
  }

  /** The engine (advanced: models, axes, caches). Undefined until ready. */
  get engine() { return this.#engine ?? undefined; }

  get options() { return { ...this.#opts }; }

  async #build(keep) {
    const seq = ++this.#buildSeq;
    const o = this.#opts;
    const source = o.dataSource ?? {};
    const keyIndex = Array.isArray(o.columns) ? new Map(o.columns.map((d, i) => [d.key, i])) : null;
    const colOfKey = (k) => keyIndex?.get(k) ?? -1;
    const initial = {
      sort: sortFromPublic(keep?.query.sort ?? o.sort ?? o.defaultSort, colOfKey).slice(0, 4),
      filter: filterFromPublic(keep?.query.filter ?? o.filter ?? o.defaultFilter, colOfKey),
      columnFilter: columnFilterFromPublic(keep?.query.columnFilter ?? o.columnFilter ?? o.defaultColumnFilter),
    };
    const keyOf = (c) => (Array.isArray(o.columns) ? o.columns[c]?.key : undefined);
    const query = { sort: sortToPublic(initial.sort, keyOf), filter: filterToPublic(initial.filter, keyOf), columnFilter: columnFilterToPublic(initial.columnFilter) };
    const initialQuery = query;
    const params = { filter: filterParamOf(initial.filter), colfilter: filterParamOf(initial.columnFilter) };

    let model = o.model;
    if (!model) {
      let layout = o.layout;
      if (!layout) {
        try {
          layout = typeof source.getLayout === 'function' ? await source.getLayout({ query }) : { rowCount: o.rowCount ?? 0 };
        } catch (err) {
          if (seq === this.#buildSeq && !this.#destroyed) this.#error(err, { kind: 'layout' });
          throw err;
        }
      }
      if (seq !== this.#buildSeq || this.#destroyed) return;
      model = layout.type === 'pivot' || (layout.rows && typeof layout.rows === 'object')
        ? createPivotModel(layout, source, this.#hookOptions(), params)
        : createTableModel(this.#modelOptions(layout), layout, source, params);
    }
    if (seq !== this.#buildSeq || this.#destroyed) return;

    this.#engine?.destroy();
    this.#theme = THEMES.includes(o.theme) ? o.theme : 'auto';
    const cb = (name) => (...args) => this.#opts[name]?.(...args);
    const canGather = (source.maxRectsPerRequest ?? 400) > 1;
    const engine = new VirtualGrid(this.#host, {
      model,
      initial,
      api: this,
      theme: this.#theme,
      ariaLabel: o.ariaLabel,
      messages: o.messages,
      // A function decides per column or level (see GridOptions.sortable); it always reads the latest option.
      sortable: typeof o.sortable === 'function' ? (target) => this.#opts.sortable?.(target) : o.sortable !== false,
      filterable: typeof o.filterable === 'function' ? (target) => this.#opts.filterable?.(target) : o.filterable !== false,
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
      format: o.format && ((v, ctx) => this.#opts.format?.(v, ctx)),
      cellClass: o.cellClass && ((v, ctx) => this.#opts.cellClass?.(v, ctx)),
      renderCell: o.renderCell && ((el, ctx) => this.#opts.renderCell?.(el, ctx)),
      renderHeader: o.renderHeader && ((el, ctx) => this.#opts.renderHeader?.(el, ctx)),
      renderEmpty: o.renderEmpty && ((el, ctx) => this.#opts.renderEmpty?.(el, ctx)),
      // The data record behind a row, for cell renderers (in-memory sources can tell; servers usually not).
      rowAt: typeof source.rowAt === 'function' ? (position) => source.rowAt(position, this.#engine?.query ?? initialQuery) : undefined,
      ...Object.fromEntries(CALLBACKS.map((n) => [n, cb(n)])),
      onError: (err, ctx) => this.#error(err, ctx),
      fetchBlock: async ({ r0, c0, nr, nc, signal, query: q }) => {
        const rects = [{ row: r0, col: c0, rowCount: nr, colCount: nc }];
        const out = normalizeCells(await source.getCells({ rects, query: q, signal }), rects);
        return { cells: out.cells[0], merges: out.merges };
      },
      fetchGather: canGather
        ? async ({ rects, signal, query: q }) => {
          const list = rects.map(([row, col, rowCount, colCount]) => ({ row, col, rowCount, colCount }));
          return normalizeCells(await source.getCells({ rects: list, query: q, signal }), list);
        }
        : undefined,
      fetchLabels: async ({ axis, level, from, n, signal, query: q }) => {
        if (typeof source.getLabels !== 'function') return Array.from({ length: n }, (_, i) => String(from + i + 1));
        const names = await source.getLabels({ axis, level, start: from, count: n, query: q, signal });
        return names.map((x) => (x === null || x === undefined ? '' : String(x)));
      },
    });
    this.#engine = engine;
    if (keep) {
      engine.scrollToVirtual(keep.vx, keep.vy);
    }
    this.#opts.onReady?.(this);
  }

  #error(err, ctx) {
    if (this.#opts.onError) this.#opts.onError(err, ctx);
    else console.warn(`@borealjs/grid-core: ${ctx?.kind ?? 'data'} request failed:`, err);
  }

  /** Hook options read through to the latest functions (so changing them needs no rebuild). */
  #hookOptions() {
    const o = this.#opts;
    const out = { ...o };
    for (const name of HOOKS) if (typeof o[name] === 'function') out[name] = (...args) => this.#opts[name]?.(...args);
    return out;
  }

  #modelOptions() {
    return this.#hookOptions();
  }

  // ---------------------------------------------------------------- options

  /**
   * Change options after creation. Callbacks and render/format functions take effect at once (cells are
   * redrawn); sort / filter / columnFilter are applied like setSort etc.; theme switches in place;
   * anything structural (dataSource, columns, sizes, feature switches) rebuilds the grid and keeps its
   * scroll position and query.
   */
  setOptions(next) {
    const prev = this.#opts;
    const changed = Object.keys(next).filter((k) => next[k] !== prev[k]);
    if (!changed.length) return Promise.resolve();
    this.#opts = { ...prev, ...next };
    const structural = changed.filter((k) => !CALLBACKS.includes(k) && !HOOKS.includes(k) && !QUERY_KEYS.includes(k) && k !== 'theme' && k !== 'controlled' && k !== 'ariaLabel'
      && !['defaultSort', 'defaultFilter', 'defaultColumnFilter'].includes(k));
    const hookPresence = changed.some((k) => HOOKS.includes(k) && typeof prev[k] !== typeof next[k]);
    if (structural.length || hookPresence || !this.#engine) return this.rebuild();
    const e = this.#engine;
    if (changed.includes('controlled')) e.o.controlled = this.#opts.controlled;
    if (changed.includes('ariaLabel')) {
      e.o.ariaLabel = next.ariaLabel;
      if (next.ariaLabel) e.scroller.setAttribute('aria-label', next.ariaLabel);
      else e.scroller.removeAttribute('aria-label');
    }
    if (changed.includes('theme')) {
      const theme = THEMES.includes(next.theme) ? next.theme : 'auto';
      this.#host.classList.replace(`vg-${this.#theme}`, `vg-${theme}`);
      this.#theme = theme;
      e.o.theme = theme;
    }
    if (changed.some((k) => HOOKS.includes(k))) e.repaint();
    const tasks = [];
    if (changed.includes('columnFilter')) tasks.push(this.setColumnFilter(next.columnFilter ?? []));
    if (changed.includes('filter')) tasks.push(this.setFilter(next.filter ?? []));
    if (changed.includes('sort')) tasks.push(this.setSort(next.sort ?? []));
    return Promise.all(tasks).then(() => undefined);
  }

  /** Build again from the current options (keeps the scroll position and the query). */
  rebuild() {
    const e = this.#engine;
    const keep = e ? { vx: e.vx, vy: e.vy, query: e.getQuery() } : undefined;
    this.ready = this.#build(keep);
    return this.ready;
  }

  // ---------------------------------------------------------------- query

  #colOfKey = (k) => this.#engine?.model.colOfKey?.(k) ?? (Array.isArray(this.#opts.columns) ? this.#opts.columns.findIndex((d) => d.key === k) : -1);

  getQuery() {
    return this.#engine ? this.#engine.getQuery() : { sort: this.#opts.sort ?? [], filter: this.#opts.filter ?? [], columnFilter: this.#opts.columnFilter ?? [] };
  }

  getSort() { return this.getQuery().sort; }

  getFilter() { return this.getQuery().filter; }

  getColumnFilter() { return this.getQuery().columnFilter; }

  /** Sort: [{ column | key, direction }] or [{ level, direction }] (pivot row dimensions). Resolves true when applied. */
  setSort(sort) {
    if (!this.#engine) return this.ready.then(() => this.setSort(sort));
    return this.#engine.setSort(sortFromPublic(sort, this.#colOfKey));
  }

  /** Row filter: [{ column | key | level, op, … }] (see the query format). Resolves true when applied. */
  setFilter(filter) {
    if (!this.#engine) return this.ready.then(() => this.setFilter(filter));
    return this.#engine.setFilter(filterFromPublic(filter, this.#colOfKey));
  }

  /** Column filter: [{ level, op, … }] on column groups (tables) or column dimensions (pivots). */
  setColumnFilter(columnFilter) {
    if (!this.#engine) return this.ready.then(() => this.setColumnFilter(columnFilter));
    return this.#engine.setColumnDimFilter(columnFilterFromPublic(columnFilter));
  }

  /** Same as a click on a column's sort control (column: source index or key). */
  toggleSort(column, additive = false) {
    const col = typeof column === 'string' ? this.#colOfKey(column) : column;
    return this.#engine?.toggleSort({ col }, additive) ?? Promise.resolve(false);
  }

  /** Open the filter dialog of a column (source index or key) or { level } of a pivot row dimension. */
  openFilter(target) {
    if (!this.#engine) return;
    const key = typeof target === 'object' ? (target.columnLevel !== undefined ? { cdim: target.columnLevel } : { dim: target.level }) : { col: typeof target === 'string' ? this.#colOfKey(target) : target };
    this.#engine.openFilter(key);
  }

  closeFilter() { this.#engine?.closeFilter(); }

  /** Stop a sort or filter that is still being applied. Returns false when none is running. */
  cancel() { return this.#engine?.cancelView() ?? false; }

  // ---------------------------------------------------------------- data and drawing

  /** Drop cached data and load what is visible again (call after the data changed). */
  refresh() { return this.#engine?.refresh() ?? this.ready; }

  /** Redraw cells and headers without reloading data. */
  repaint() { this.#engine?.repaint(); }

  /** Merged cells set from code: [{ r0, c0, nr, nc, label? }] in source coordinates. */
  setMerges(list) { this.#engine?.setMerges(list); }

  // ---------------------------------------------------------------- navigation and selection

  scrollToCell(row, col = 0) { this.#engine?.scrollToCell(row, col); }

  /** Visible window: { firstRow, lastRow, firstCol, lastCol } (or undefined before the first frame). */
  get visibleRange() {
    const v = this.#engine?.view;
    return v ? { firstRow: v.firstRow, lastRow: v.lastRow, firstCol: v.firstCol, lastCol: v.lastCol } : undefined;
  }

  get rowCount() { return this.#engine?.rows.count ?? 0; }

  get columnCount() { return this.#engine?.cols.count ?? 0; }

  getSelection() { return this.#engine?.getSelection(); }

  setSelection(selection) { this.#engine?.setSelection(selection); }

  selectAll() { this.#engine?.selectAll(); }

  selectionInfo() { return this.#engine?.selectionInfo(); }

  copySelection() { return this.#engine?.copySelection() ?? Promise.resolve({ ok: false, reason: 'not ready' }); }

  cellValue(row, col) { return this.#engine?.cellValue(row, col); }

  cellText(row, col) { return this.#engine?.cellText(row, col); }

  setColumnWidth(col, width) { this.#engine?.setColumnWidth(col, width); }

  focus() { this.#engine?.scroller.focus({ preventScroll: true }); }

  // ---------------------------------------------------------------- pivot groups

  /** Pivot levels: { rows: [{ name, collapsible }], cols: [...] } (undefined for tables). */
  get levels() { return this.#engine?.model.levels; }

  toggleGroup(axis, level, group) { this.#engine?.toggleGroup(axis, level, group); }

  /** Show `axis` ('rows' | 'cols') down to `level` (deeper levels collapsed). */
  showLevel(axis, level) {
    const e = this.#engine;
    if (e?.model.showLevel) e.restructure(axis, () => e.model.showLevel(axis, level));
  }

  expandAll(axis) {
    const e = this.#engine;
    if (e?.model.expandAll) e.restructure(axis, () => e.model.expandAll(axis));
  }

  /** Render and cache statistics. */
  stats() { return this.#engine?.takeStats(); }

  destroy() {
    this.#destroyed = true;
    this.#buildSeq++;
    this.#engine?.destroy();
    this.#engine = null;
  }
}
