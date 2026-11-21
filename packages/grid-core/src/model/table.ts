// A table: rows from the data source (count from `getLayout`, or the `rowCount` option), columns from
// `columns` (array) or `columnCount` + `getColumn(index)` (for very wide tables), one header row and an
// optional row-number column.

import { ResizableAxis } from '../axes/resizable.js';
import { UniformAxis } from '../axes/axis.js';
import { EMPTY_QUERY, matchesName, type Condition, type ViewKey } from '../query.js';
import type { ColumnDef, DataSource, FilterKind, GridOptions, TableLayout } from '../types.js';
import { ColumnsAxis } from './columns-axis.js';
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
  const sourceCount = list ? list.length : (o.columnCount ?? layout.columnCount ?? 0);
  if (!list && typeof o.getColumn !== 'function' && !(sourceCount >= 0)) throw new TypeError('createGrid: pass `columns`, or `columnCount` with `getColumn`');

  const defCache = new Map<number, ColumnDef>();
  const defOf = (src: number): ColumnDef => {
    if (list) return list[src] ?? {};
    let d = defCache.get(src);
    if (d === undefined) {
      d = o.getColumn?.(src) ?? {};
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
    const seen = new Set<string>();
    for (let i = 0; i < sourceCount; i++) {
      const g = defOf(i).group;
      if (g !== undefined) seen.add(String(g));
    }
    return [...seen];
  };
  const chooser = o.columnChooser ?? (!!list && list.some((d) => d.group !== undefined));
  const columnsLabel = () => o.messages?.columns ?? 'Columns';

  function buildAxis(colFilters: Condition[]): ColumnsAxis {
    let visible: Int32Array | null = null;
    const hidden = list ? list.some((d) => d.hidden) : false;
    if (hidden || colFilters.length) {
      const out = new Int32Array(sourceCount);
      let n = 0;
      for (let i = 0; i < sourceCount; i++) {
        const d = defOf(i);
        if (d.hidden) continue;
        if (colFilters.length && !colFilters.every((f) => matchesName(f, d.group ?? ''))) continue;
        out[n++] = i;
      }
      visible = out.slice(0, n);
    }
    return widthOf ? new ColumnsAxis(sourceCount, widthOf, visible) : ColumnsAxis.uniform(sourceCount, defaultWidth, visible);
  }

  const cols = new ResizableAxis(buildAxis(initial.colfilter ? JSON.parse(initial.colfilter) : []));
  const src = (c: number) => cols.base.sourceOf(c);
  const rowHeader = o.rowHeader === false ? null : { width: 72, title: '#', ...(typeof o.rowHeader === 'object' ? o.rowHeader : {}) };
  const rowLabel = rowHeader?.label ?? ((r: number) => numberFormat.format(r + 1));
  const totalRows = layout.totalRowCount ?? layout.rowCount ?? o.rowCount ?? 0;
  let currentFilter = initial.filter ?? '';
  let currentColFilter = initial.colfilter ?? '';
  const titleOf = (s: number, label: LabelLookup): string | undefined => {
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
    serverColFilter: false, // hiding columns is done here; the data source is not told
    rowBandFilter: () => (chooser && o.filterable !== false ? { cdim: 0 } : null), // the corner: choose columns by group
    colSortKey: (c) => (sortable(defOf(src(c))) ? { col: src(c) } : null),
    colFilterKey: (c) => (filterDesc(defOf(src(c))) ? { col: src(c) } : null),
    sortKeyName: (key, label) => (key.cdim !== undefined ? columnsLabel() : titleOf(key.col!, label) ?? `Column ${key.col! + 1}`),
    filterOptions(key: ViewKey, label): FilterDescription | null {
      if (key.cdim !== undefined) return { kind: 'values', values: groupNames(), name: columnsLabel() };
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
    async applyView({ filter, colfilter = '', query, signal, onProgress }) {
      if (filter !== currentFilter) {
        const res = filter ? ((await source.getLayout!({ query, signal, onProgress })) as TableLayout) : { rowCount: model.totalRows };
        model.rows = new UniformAxis(res.rowCount, rowHeight);
        currentFilter = filter;
      }
      if (colfilter !== currentColFilter) {
        cols.base = buildAxis(colfilter ? JSON.parse(colfilter) : []);
        cols.refresh();
        currentColFilter = colfilter;
      }
    },
  };
  return model;
}
