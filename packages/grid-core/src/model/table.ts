// A table: rows from the data source (count from `getLayout`, or the `rowCount` option), columns from
// `columns` (array) or `columnCount` + `getColumn(index)` (for very wide tables), one header row and an
// optional row-number column.

import { ResizableAxis } from '../axes/resizable.js';
import { UniformAxis } from '../axes/axis.js';
import { EMPTY_QUERY, matchesName, type Condition, type ViewKey } from '../query.js';
import type { ColumnDef, DataSource, FilterKind, GridOptions, TableLayout } from '../types.js';
import { ColumnsAxis } from './columns-axis.js';
import { RunOrder, type CompactOrder } from './column-order.js';
import type { ColumnInfo, FilterDescription, GridModel, InitialView, LabelLookup, Segment } from './types.js';

export const FILTER_VALUES_LIMIT = 1000;

const numberFormat = new Intl.NumberFormat();
const FILTER_TYPES = new Set(['number', 'date', 'text', 'values']);
/** Column definitions kept for getColumn (very wide tables) before the cache is dropped. */
const DEF_CACHE_MAX = 20_000;

export type ModelOptions = Partial<GridOptions<any>>;

export interface TableModel extends GridModel {
  rows: UniformAxis;
  cols: ResizableAxis<ColumnsAxis>;
  totalRows: number;
  colSource(c: number): number;
  keyOf(src: number): string | undefined;
  colOfKey(key: string | undefined): number;
}

export function createTableModel(options: ModelOptions, layout: TableLayout, source: DataSource, initial: InitialView = {}): TableModel {
  const o = options;
  const rowHeight = o.rowHeight ?? 28;
  const defaultWidth = o.columnWidth ?? 132;
  const list: ColumnDef[] | null = Array.isArray(o.columns) ? o.columns : null;
  let sourceCount = list ? list.length : (o.columnCount ?? layout.columnCount ?? 0);
  // Columns described by the data source on demand (getColumns), for tables with very many columns.
  const described = !list && typeof source.getColumns === 'function' && layout.describedColumns !== false;
  if (!list && typeof o.getColumn !== 'function' && !described && !(sourceCount >= 0)) throw new TypeError('createGrid: pass `columns`, or `columnCount` with `getColumn`');

  const defCache = new Map<number, ColumnDef>();
  const definedOnly = (d: ColumnDef | undefined): ColumnDef => (d ? Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) as ColumnDef : {});
  const defOf = (src: number): ColumnDef => {
    if (list) return list[src] ?? {};
    let d = defCache.get(src);
    if (d === undefined) {
      // What code says (getColumn: functions, overrides) wins over what the data source described.
      const told = described ? model.describe?.(src) : undefined;
      d = told ? { ...(told as ColumnDef), ...definedOnly(o.getColumn?.(src)) } : (o.getColumn?.(src) ?? {});
      if (described && !told) return d; // not described yet: do not keep it
      if (defCache.size > DEF_CACHE_MAX) defCache.clear();
      defCache.set(src, d);
    }
    return d;
  };
  const keyIndex = list ? new Map(list.map((d, i) => [d.key, i] as const).filter(([k]) => k !== undefined)) : null;
  const canFilter = typeof source.getLayout === 'function';
  const sortable = (d: ColumnDef) => o.sortable !== false && d.sortable !== false;
  const filterDesc = (d: ColumnDef): Exclude<FilterKind, false> | null => {
    if (!canFilter || o.filterable === false || d.filter === false) return null;
    return d.filter ?? (d.type === 'number' || d.type === 'date' ? d.type : 'text');
  };
  const resizable = (d: ColumnDef) => o.resizable !== false && d.resizable !== false;
  const hasCustomWidths = !!list && list.some((d) => typeof d.width === 'number');
  const widthOf = hasCustomWidths ? (src: number) => Math.max(o.minColumnWidth ?? 48, list![src].width ?? defaultWidth) : null;
  const groupNames = (): string[] => {
    if (o.columnGroups) return o.columnGroups;
    if (described) return []; // the data source lists them (getFilterValues), not a scan of every column
    const seen = new Set<string>();
    for (let i = 0; i < sourceCount; i++) {
      const g = defOf(i).group;
      if (g !== undefined) seen.add(String(g));
    }
    return [...seen];
  };
  const chooser = o.columnChooser ?? (!!list && list.some((d) => d.group !== undefined));
  const columnsLabel = () => o.messages?.columns ?? 'Columns';

  // Display order as runs of source columns (works for a million columns: see RunOrder). With a column
  // list, columns marked `pinned` come first; `pinnedColumns` pins that many leading columns.
  const pinnedOf = (s: number) => !!list && !!list[s]?.pinned;
  const withPinnedFirst = (order: RunOrder): RunOrder => {
    if (!list || !list.some((d) => d.pinned)) return order;
    const all: number[] = [];
    order.forEach((s) => all.push(s));
    return RunOrder.fromList(sourceCount, [...all.filter(pinnedOf), ...all.filter((s) => !pinnedOf(s))]);
  };
  const orderFrom = (spec: GridOptions['columnOrder'] | CompactOrder | number[] | undefined): RunOrder => {
    if (!Array.isArray(spec)) return withPinnedFirst(new RunOrder(sourceCount));
    if (spec.some(Array.isArray)) return withPinnedFirst(RunOrder.fromCompact(sourceCount, spec as CompactOrder));
    const list2 = (spec as (string | number)[]).map((k) => (typeof k === 'number' ? k : keyIndex?.get(k) ?? -1));
    return withPinnedFirst(list ? RunOrder.fromList(sourceCount, list2) : RunOrder.fromCompact(sourceCount, list2));
  };
  let order = orderFrom(o.columnOrder);
  let pinned = 0;
  let colFilterList: Condition[] = initial.colfilter ? JSON.parse(initial.colfilter) : [];

  function buildAxis(colFilters: Condition[]): ColumnsAxis {
    let visible: Int32Array | RunOrder | null = null;
    const hidden = list ? list.some((d) => d.hidden) : false;
    if (described) colFilters = []; // the data source applies column filters (columns are renumbered)
    let pinnedShown = 0;
    if (hidden || colFilters.length) {
      // Some columns are not shown: list the visible ones (column lists, or the column chooser).
      const out = new Int32Array(sourceCount);
      let n = 0;
      order.forEach((i) => {
        const d = defOf(i);
        if (d.hidden) return;
        if (colFilters.length && !colFilters.every((f) => matchesName(f, d.group ?? ''))) return;
        if (pinnedOf(i)) pinnedShown++;
        out[n++] = i;
      });
      visible = out.slice(0, n);
    } else {
      if (!order.identity) visible = order;
      if (list) for (let i = 0; i < sourceCount && pinnedOf(order.sourceOf(i)); i++) pinnedShown++;
    }
    const axis = widthOf ? new ColumnsAxis(sourceCount, widthOf, visible) : ColumnsAxis.uniform(sourceCount, defaultWidth, visible);
    pinned = Math.min(axis.count, Math.max(0, Math.floor(o.pinnedColumns ?? pinnedShown)));
    return axis;
  }

  const cols = new ResizableAxis(buildAxis(colFilterList));
  const src = (c: number) => cols.base.sourceOf(c);
  // Row checkboxes live in the row-number column; without row numbers they get a narrow column of their own.
  const checks = !!o.rowSelection;
  const CHECK_W = 28;
  // Row numbers get room for the largest one ("1,000,000,000" needs more than "200,000").
  const rowsForWidth = layout.totalRowCount ?? layout.rowCount ?? o.rowCount ?? 0;
  const numberWidth = Math.max(72, Math.ceil(numberFormat.format(rowsForWidth).length * 7.5 + 20));
  const numbers = o.rowHeader === false ? null : { width: numberWidth, title: '#', ...(typeof o.rowHeader === 'object' ? o.rowHeader : {}) };
  const rowHeader = numbers
    ? { ...numbers, width: numbers.width + (checks ? CHECK_W : 0) }
    : (checks ? { width: 40, title: '', label: () => '' } : null);
  const rowLabel = rowHeader?.label ?? ((r: number) => numberFormat.format(r + 1));
  const totalRows = layout.totalRowCount ?? layout.rowCount ?? o.rowCount ?? 0;
  let currentFilter = initial.filter ?? '';
  // Row sources load the first page of a new sort through getLayout, so a slow server sort shows progress.
  const layoutOnSort = !!(source as { layoutOnSort?: boolean }).layoutOnSort;
  let currentSort: string | undefined;
  let currentColFilter = initial.colfilter ?? '';
  const titleOf = (s: number, label: LabelLookup): string | undefined => {
    // Described columns: asking for the label loads the column's description with it.
    if (described) {
      const loaded = label('cols', 0, s);
      const d = defOf(s);
      if (d.title !== undefined) return String(d.title);
      return loaded === undefined ? undefined : loaded || (d.key !== undefined ? String(d.key) : `Column ${s + 1}`);
    }
    const d = defOf(s);
    if (d.title !== undefined) return String(d.title);
    if (typeof source.getLabels === 'function') return label('cols', 0, s);
    return d.key !== undefined ? String(d.key) : `Column ${s + 1}`;
  };
  const infoCache = new Map<number, ColumnInfo>();

  const model: TableModel = {
    hostClass: 'vg-table',
    rows: new UniformAxis(layout.rowCount ?? o.rowCount ?? 0, rowHeight),
    totalRows,
    cols,
    rowBands: rowHeader ? [{ name: rowHeader.title ?? '', width: rowHeader.width }] : [],
    colTiers: [{ name: '', height: o.headerHeight ?? 34 }],
    rowKind: (r) => {
      const extra = o.rowClass?.(r);
      return (r % 2 === 1 ? ' vg-odd' : '') + (extra ? ` ${extra}` : '');
    },
    colKind: () => '',
    rowSegments(a, b) {
      const out: Segment[] = [];
      if (!rowHeader) return out;
      for (let i = a; i <= b; i++) out.push({ key: i, a: i, b: i, t0: 0, t1: 0, label: String(rowLabel(i)), cls: 'vg-rownum' });
      return out;
    },
    colSegments(a, b, label) {
      const out: Segment[] = [];
      for (let c = a; c <= b; c++) {
        const s = src(c);
        const d = defOf(s);
        out.push({
          key: s,
          a: c,
          b: c,
          t0: 0,
          t1: 0,
          label: titleOf(s, label),
          cls: `vg-colname${d.type === 'number' ? ' vg-end' : ''}${d.headerClass ? ` ${d.headerClass}` : ''}`,
          resizable: resizable(d),
          movable: o.reorderable !== false && d.reorderable !== false,
          sort: sortable(d) ? { col: s } : undefined,
          filter: filterDesc(d) ? { col: s } : undefined,
          column: d,
          source: s,
          render: d.renderHeader,
        });
      }
      return out;
    },
    columnInfo(s) {
      let info = infoCache.get(s);
      if (info === undefined) {
        const d = defOf(s);
        const align = d.align ?? (d.type === 'number' ? 'end' : undefined);
        info = {
          column: d,
          format: d.format ?? o.format,
          cellClass: d.cellClass ?? o.cellClass,
          renderCell: d.renderCell ?? o.renderCell,
          cls: `${align === 'end' ? ' vg-end' : align === 'center' ? ' vg-center' : ''}${d.className ? ` ${d.className}` : ''}`,
        };
        if (described && !model.describe?.(s)) return info; // drawn plain until described
        if (infoCache.size > DEF_CACHE_MAX) infoCache.clear();
        infoCache.set(s, info);
      }
      return info;
    },
    keyOf: (s) => defOf(s).key,
    colOfKey: (key) => (keyIndex ? keyIndex.get(key) ?? -1 : -1),
    sortLimit: layout.maxSortRows,
    filterLimit: layout.maxFilterRows,
    colSource: src, // data, sort keys and filters address source columns
    // Hiding columns is done here, except for described columns: the data source filters (and renumbers) them.
    serverColFilter: described,
    describedColumns: described,
    columnsDescribed(from, n) {
      for (let s = from; s < from + n; s++) {
        defCache.delete(s);
        infoCache.delete(s);
      }
    },
    rowBandFilter: () => (chooser && o.filterable !== false ? { cdim: 0 } : null), // the corner: choose columns by group
    colSortKey: (c) => (sortable(defOf(src(c))) ? { col: src(c) } : null),
    colFilterKey: (c) => (filterDesc(defOf(src(c))) ? { col: src(c) } : null),
    sortKeyName: (key, label) => (key.cdim !== undefined ? columnsLabel() : titleOf(key.col!, label) ?? `Column ${key.col! + 1}`),
    filterOptions(key: ViewKey, label): FilterDescription | null {
      if (key.cdim !== undefined) {
        // Described columns: the data source lists the groups (a million columns are not scanned here).
        if (described && !o.columnGroups && typeof source.getFilterValues === 'function') {
          const getFilterValues = source.getFilterValues.bind(source);
          return { kind: 'values', name: columnsLabel(), search: (q, signal) => getFilterValues({ axis: 'cols', level: 0, search: q, limit: FILTER_VALUES_LIMIT, query: EMPTY_QUERY, signal }) };
        }
        return { kind: 'values', values: groupNames(), name: columnsLabel() };
      }
      const col = key.col!;
      const d = defOf(col);
      const f = filterDesc(d);
      if (!f) return null;
      const name = titleOf(col, label) ?? `Column ${col + 1}`;
      if (typeof f === 'object' && 'render' in f && typeof f.render === 'function') return { kind: 'custom', name, render: f.render, op: f.op ?? 'custom', column: d };
      const type = typeof f === 'string' ? f : (f as { type?: string }).type ?? 'text';
      if (!FILTER_TYPES.has(type)) throw new TypeError(`column ${name}: unknown filter type "${type}"`);
      if (type !== 'values') return { kind: type as 'number' | 'date' | 'text', name } as FilterDescription;
      const values = typeof f === 'object' ? (f as { values?: string[] }).values : undefined;
      if (values) return { kind: 'values', name, values: values.map(String) };
      if (typeof source.getFilterValues !== 'function') return { kind: 'text', name };
      const getFilterValues = source.getFilterValues.bind(source);
      return {
        kind: 'values',
        name,
        search: (q, signal) => getFilterValues({ column: col, key: d.key, search: q, limit: FILTER_VALUES_LIMIT, query: EMPTY_QUERY, signal }),
      };
    },
    // The data changed (refresh): ask for the row count again.
    async reload({ query }) {
      if (typeof source.getLayout !== 'function') return;
      const res = (await source.getLayout({ query })) as TableLayout;
      model.rows = new UniformAxis(res.rowCount, rowHeight);
      if (res.totalRowCount !== undefined) model.totalRows = res.totalRowCount;
    },
    // Sorting keeps the row count; a filter changes it, so ask the data source how many rows match.
    // A column filter just changes which source columns are shown.
    async applyView({ sort, filter, colfilter = '', query, signal, onProgress }) {
      let fetched: TableLayout | null = null;
      const fetchLayout = async () => (fetched ??= (await source.getLayout!({ query, signal, onProgress })) as TableLayout);
      const sortChanged = layoutOnSort && sort !== currentSort;
      currentSort = sort;
      if (sortChanged && filter === currentFilter && typeof source.getLayout === 'function') {
        model.rows = new UniformAxis((await fetchLayout()).rowCount, rowHeight);
      }
      if (filter !== currentFilter) {
        const res = filter ? await fetchLayout() : { rowCount: model.totalRows };
        model.rows = new UniformAxis(res.rowCount, rowHeight);
        currentFilter = filter;
      }
      if (colfilter !== currentColFilter) {
        colFilterList = colfilter ? JSON.parse(colfilter) : [];
        if (described) {
          // The data source chose the columns: new count, columns renumbered, widths and order start over.
          const res = await fetchLayout();
          sourceCount = res.columnCount ?? sourceCount;
          order = new RunOrder(sourceCount);
          cols.overrides.clear();
          defCache.clear();
          infoCache.clear();
        }
        cols.base = buildAxis(colFilterList);
        cols.refresh();
        currentColFilter = colfilter;
      }
    },
    pinnedCols: () => pinned,
    columnOrder: () => order.toCompact(),
    setColumnOrder(next) {
      order = orderFrom(next);
      cols.base = buildAxis(colFilterList);
      cols.refresh();
    },
    moveColumn(from, to) {
      // Display positions of the visible columns; hidden ones keep their places in the full order.
      const base = cols.base;
      const a = order.fromSource(base.sourceOf(from));
      const b = order.fromSource(base.sourceOf(to));
      if (a < 0 || b < 0) return;
      order.move(a, b);
      cols.base = buildAxis(colFilterList);
      cols.refresh();
    },
  };
  return model;
}
