// Layouts turn options + a data source into the model the grid engine draws from.
//
// Model contract (also usable directly for custom layouts, see `createGrid({ model })`):
//   rows, cols            axes: { count, total, minSize, offsetOf(i), sizeOf(i), indexAt(px) }
//   rowBands              row header columns, outermost first: [{ name, width }]
//   colTiers              column header rows, outermost first: [{ name, height }]
//   rowKind(r)/colKind(c) extra CSS classes for a body row / column (subtotals, zebra)
//   rowSegments(a, b, label) / colSegments(a, b, label)
//                         header segments overlapping items [a, b]:
//                         { key, a, b, t0, t1, label, cls, resizable, sort?, filter?, column?, render? }
//                         label(axis, level, index) returns a loaded label, or undefined while loading.
//   columnInfo(src)       per source column: { column, format, cellClass, renderCell, cls } (optional)
//   Sorting (optional):   segment.sort = { col }; rowBandSort(b) -> { dim }; colSortKey(c);
//                         sortKeyName(key, label); sortLimit (max rows for a multi-column sort).
//   Filtering (optional): segment.filter = { col }; rowBandFilter(b) -> { dim } | { cdim }; colFilterKey(c);
//                         filterOptions(key, label) -> { kind, values?, search?, render?, name } (may be async).
//                         A 'values' filter lists `values`, or calls search(q, signal) ->
//                         { total, matches, values (first 1000 matching) } for lists too long to send.
//   Column filters:       colTierFilter(t) -> { cdim }; serverColFilter = the data source applies them
//                         (columns renumbered) vs the model hiding columns itself.
//   applyView({ sort, filter, colfilter, query }) (async) when any of them changes; updates rows / cols.

import { TreeAxis } from './tree.js';
import { ResizableAxis, UniformAxis } from './grid.js';
import { EMPTY_QUERY, matchesName } from './query.js';

export { defaultFormat } from './query.js';

const numberFormat = new Intl.NumberFormat();
export const FILTER_VALUES_LIMIT = 1000;

/**
 * The visible columns of a table: all source columns, or a sorted subset (hidden columns, column
 * filters). Widths are per source column (or one default), kept as prefix sums over the visible ones.
 */
class ColumnsAxis {
  constructor(sourceCount, widthOf, visible) {
    this.sourceCount = sourceCount;
    this.visible = visible; // Int32Array of source indexes, ascending, or null = every column
    this.count = visible ? visible.length : sourceCount;
    if (widthOf) {
      const offsets = new Float64Array(this.count + 1);
      let min = Infinity;
      for (let i = 0; i < this.count; i++) {
        const w = widthOf(this.sourceOf(i));
        offsets[i + 1] = offsets[i] + w;
        if (w < min) min = w;
      }
      this.offsets = offsets;
      this.total = offsets[this.count];
      this.minSize = Number.isFinite(min) ? min : 100;
    } else {
      this.width = 100;
    }
  }

  static uniform(sourceCount, width, visible) {
    const axis = new ColumnsAxis(sourceCount, null, visible);
    axis.width = width;
    axis.total = axis.count * width;
    axis.minSize = width;
    return axis;
  }

  sourceOf(i) { return this.visible ? this.visible[i] : i; }

  fromSource(src) {
    if (!this.visible) return src >= 0 && src < this.sourceCount ? src : -1;
    let lo = 0;
    let hi = this.visible.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.visible[mid];
      if (v === src) return mid;
      if (v < src) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  offsetOf(i) { return this.offsets ? this.offsets[i] : i * this.width; }

  sizeOf(i) { return this.offsets ? this.offsets[i + 1] - this.offsets[i] : this.width; }

  indexAt(px) {
    if (this.count === 0 || px <= 0) return 0;
    if (!this.offsets) return Math.min(Math.floor(px / this.width), this.count - 1);
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      if (this.offsets[mid] <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

const FILTER_TYPES = { number: 'number', date: 'date', text: 'text', values: 'values' };

/**
 * A table: rows from the data source (count from `getLayout`, or the `rowCount` option), columns from
 * `columns` (array) or `columnCount` + `getColumn(index)` (for very wide tables), one header row and
 * an optional row-number column.
 */
export function createTableModel(options, layout, source, initial = {}) {
  const o = options;
  const rowHeight = o.rowHeight ?? 28;
  const defaultWidth = o.columnWidth ?? 132;
  const list = Array.isArray(o.columns) ? o.columns : null;
  const sourceCount = list ? list.length : (o.columnCount ?? layout.columnCount ?? 0);
  if (!list && typeof o.getColumn !== 'function' && !(sourceCount >= 0)) throw new TypeError('createGrid: pass `columns`, or `columnCount` with `getColumn`');
  const defCache = new Map();
  const defOf = (src) => {
    if (list) return list[src] ?? {};
    let d = defCache.get(src);
    if (d === undefined) {
      d = o.getColumn?.(src) ?? {};
      if (defCache.size > 20_000) defCache.clear();
      defCache.set(src, d);
    }
    return d;
  };
  const keyIndex = list ? new Map(list.map((d, i) => [d.key, i]).filter(([k]) => k !== undefined)) : null;
  const canFilter = typeof source.getLayout === 'function';
  const sortable = (d) => o.sortable !== false && d.sortable !== false;
  const filterDesc = (d) => {
    if (!canFilter || o.filterable === false || d.filter === false) return null;
    const f = d.filter ?? (d.type === 'number' || d.type === 'date' ? d.type : 'text');
    return f;
  };
  const resizable = (d) => o.resizable !== false && d.resizable !== false;
  const hasCustomWidths = !!list && list.some((d) => typeof d.width === 'number');
  const widthOf = hasCustomWidths ? (src) => Math.max(o.minColumnWidth ?? 48, list[src].width ?? defaultWidth) : null;
  const groupNames = () => {
    if (o.columnGroups) return o.columnGroups;
    const seen = new Set();
    for (let i = 0; i < sourceCount; i++) {
      const g = defOf(i).group;
      if (g !== undefined) seen.add(String(g));
    }
    return [...seen];
  };
  const chooser = o.columnChooser ?? (!!list && list.some((d) => d.group !== undefined));

  function buildAxis(colFilters) {
    let visible = null;
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
  const src = (c) => cols.base.sourceOf(c);
  const rowHeader = o.rowHeader === false ? null : { width: 72, title: '#', ...(typeof o.rowHeader === 'object' ? o.rowHeader : {}) };
  const rowLabel = rowHeader?.label ?? ((r) => numberFormat.format(r + 1));
  const totalRows = layout.totalRowCount ?? layout.rowCount ?? o.rowCount ?? 0;
  let currentFilter = initial.filter ?? '';
  let currentColFilter = initial.colfilter ?? '';
  const titleOf = (s, label) => {
    const d = defOf(s);
    if (d.title !== undefined) return String(d.title);
    if (typeof source.getLabels === 'function') return label('cols', 0, s);
    return d.key !== undefined ? String(d.key) : `Column ${s + 1}`;
  };
  const infoCache = new Map();

  const model = {
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
      const out = [];
      if (!rowHeader) return out;
      for (let i = a; i <= b; i++) out.push({ key: i, a: i, b: i, t0: 0, t1: 0, label: String(rowLabel(i)), cls: 'vg-rownum' });
      return out;
    },
    colSegments(a, b, label) {
      const out = [];
      for (let c = a; c <= b; c++) {
        const s = src(c);
        const d = defOf(s);
        out.push({
          key: s, a: c, b: c, t0: 0, t1: 0,
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
        if (infoCache.size > 20_000) infoCache.clear();
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
    sortKeyName: (key, label) => (key.cdim !== undefined ? o.messages?.columns ?? 'Columns' : titleOf(key.col, label) ?? `Column ${key.col + 1}`),
    filterOptions(key, label) {
      if (key.cdim !== undefined) return { kind: 'values', values: groupNames(), name: o.messages?.columns ?? 'Columns' };
      const d = defOf(key.col);
      const f = filterDesc(d);
      if (!f) return null;
      const name = titleOf(key.col, label) ?? `Column ${key.col + 1}`;
      if (typeof f === 'object' && typeof f.render === 'function') return { kind: 'custom', name, render: f.render, op: f.op ?? 'custom', column: d };
      const type = typeof f === 'string' ? f : f.type ?? 'text';
      if (!FILTER_TYPES[type]) throw new TypeError(`column ${name}: unknown filter type "${type}"`);
      if (type !== 'values') return { kind: type, name };
      const values = typeof f === 'object' ? f.values : undefined;
      if (values) return { kind: 'values', name, values: values.map(String) };
      if (typeof source.getFilterValues !== 'function') return { kind: 'text', name };
      return {
        kind: 'values',
        name,
        search: (q, signal) => source.getFilterValues({ column: key.col, key: d.key, search: q, limit: FILTER_VALUES_LIMIT, query: EMPTY_QUERY, signal }),
      };
    },
    // The data changed (refresh): ask for the row count again.
    async reload({ query }) {
      if (typeof source.getLayout !== 'function') return;
      const res = await source.getLayout({ query });
      model.rows = new UniformAxis(res.rowCount, rowHeight);
      if (res.totalRowCount !== undefined) model.totalRows = res.totalRowCount;
    },
    // Sorting keeps the row count; a filter changes it, so ask the data source how many rows match.
    // A column filter just changes which source columns are shown.
    async applyView({ filter, colfilter = '', query }) {
      if (filter !== currentFilter) {
        const res = filter ? await source.getLayout({ query }) : { rowCount: model.totalRows };
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

export function createPivotModel(meta, source, options = {}, initial = {}) {
  let rowTree = new TreeAxis(meta.rows);
  let rowMaps = meta.rowMaps ?? null; // per level: sorted group index -> original group index (null = unsorted)
  let colTree = new TreeAxis(meta.cols);
  let cols = new ResizableAxis(colTree);
  let colMaps = meta.colMaps ?? null; // per column level: displayed group -> original group (null = unfiltered)
  let currentColFilter = initial.colfilter ?? '';
  const colLevelNames = [...meta.cols.levels.map((l) => l.name), meta.cols.leafName];
  const ROW_BAND_WIDTHS = options.rowHeaderWidths ?? [136, 132, 124, 176];
  const treeOf = (axis) => (axis === 'rows' ? rowTree : colTree);
  const changed = (axis) => {
    if (axis === 'cols') cols.refresh(); // column widths are kept by source index
  };

  const kind = (tree, i) => {
    const loc = tree.locate(i);
    if (loc.kind === 'leaf') return '';
    if (loc.kind === 'grand') return ' vg-grand';
    return ` vg-sub vg-sub${loc.level}${loc.kind === 'collapsed' ? ' vg-collapsed' : ''}`;
  };

  const bandNames = [...meta.rows.levels.map((l) => l.name), meta.rows.leafName];
  const cellInfo = { column: undefined, format: options.format, cellClass: options.cellClass, renderCell: options.renderCell, cls: '' };

  const model = {
    hostClass: 'vg-pivot',
    totalRows: undefined,
    rows: rowTree,
    cols,
    rowBands: [...meta.rows.levels.map((l) => l.name), meta.rows.leafName].map((name, i) => ({ name, width: ROW_BAND_WIDTHS[i] ?? 128 })),
    colTiers: [...meta.cols.levels.map((l) => l.name), meta.cols.leafName].map((name) => ({ name, height: 28 })),
    rowKind: (r) => kind(rowTree, r) || (r % 2 === 1 ? ' vg-odd' : ''),
    colKind: (c) => kind(colTree, c),
    rowSegments: (a, b, label) => treeSegments(rowTree, 'rows', a, b, label),
    columnInfo: () => cellInfo,
    colSegments: (a, b, label) => treeSegments(colTree, 'cols', a, b, label, true),

    // Visible <-> source mapping for data blocks.
    rowSource: (r) => rowTree.sourceOf(r),
    colSource: (c) => colTree.sourceOf(c),
    rowSourceCount: rowTree.fullCount,
    colSourceCount: colTree.fullCount,
    // A collapsed group stands for many source items, so it is not part of any merged cell (merges split around it).
    rowExact: (r) => rowTree.locate(r).kind !== 'collapsed',
    colExact: (c) => colTree.locate(c).kind !== 'collapsed',
    anchorOf: (axis, i) => treeOf(axis).anchorSourceOf(i),
    visibleOf(axis, src) {
      const tree = treeOf(axis);
      const exact = tree.fromSource(src);
      return exact >= 0 ? [exact, true] : [tree.fromSource(src, true), false];
    },

    // Expand / collapse.
    levels: {
      rows: meta.rows.levels.map((l, i) => ({ name: l.name, collapsible: rowTree.canCollapse(i) })),
      cols: meta.cols.levels.map((l, i) => ({ name: l.name, collapsible: colTree.canCollapse(i) })),
    },
    groupStart: (axis, level, group) => treeOf(axis).groupStart(level, group),
    // Keyboard expand/collapse (Alt+Shift+arrows): which group to act on for the item at index i.
    expandTarget(axis, i) {
      const loc = treeOf(axis).locate(i);
      return loc.kind === 'collapsed' ? { level: loc.level, group: loc.path[loc.level] } : null;
    },
    collapseTarget(axis, i) {
      const tree = treeOf(axis);
      const loc = tree.locate(i);
      if (loc.kind === 'grand') return null;
      // Innermost collapsible group that contains the item (a collapsed group's parent; a subtotal's own group).
      const start = loc.kind === 'collapsed' ? loc.level - 1 : loc.kind === 'subtotal' ? loc.level : tree.depth - 1;
      for (let level = start; level >= 0; level--) {
        if (tree.canCollapse(level)) return { level, group: loc.path[level] };
      }
      return null;
    },
    toggleGroup(axis, level, group) {
      treeOf(axis).toggle(level, group);
      changed(axis);
    },
    showLevel(axis, level) {
      treeOf(axis).showLevel(level);
      changed(axis);
    },
    expandAll(axis) {
      treeOf(axis).expandAll();
      changed(axis);
    },

    // Sorting: by a value column (every level's groups by their subtotal there, products by value) or by
    // a row dimension's names. The server returns the reordered row layout.
    rowBandSort: (b) => ({ dim: b }),
    rowBandFilter: (b) => ({ dim: b }),
    colFilterKey: () => null, // value filters are not supported in the pivot (only dimensions)
    // Column dimensions: Measure / Year / Quarter from the corner, Month from the month headers.
    colTierFilter: (t) => ({ cdim: t }),
    serverColFilter: true,
    colSortKey: (c) => ({ col: colTree.sourceOf(c) }),
    sortKeyName(key, label) {
      if (key.cdim !== undefined) return colLevelNames[key.cdim] ?? `Column level ${key.cdim + 1}`;
      if (key.dim !== undefined) return bandNames[key.dim] ?? `Level ${key.dim + 1}`;
      const visible = colTree.fromSource(key.col, true);
      const loc = colTree.locate(visible);
      const parts = loc.path.map((g, L) => label('cols', L, g) ?? '…');
      if (loc.kind === 'leaf') parts.push(label('cols', colTree.depth, loc.leaf) ?? '…');
      else parts[parts.length - 1] += ' total';
      return parts.join(' · ');
    },
    // Dimension names come from the server's distinct-value search (unfiltered data, first 1000 that
    // match), so a 20,000-year or million-city list opens at once. Products are filtered by text.
    filterOptions(key) {
      if (typeof source.getFilterValues !== 'function') {
        // Without a value list, dimensions are filtered by text.
        const names = key.cdim !== undefined ? colLevelNames : bandNames;
        const L = key.cdim ?? key.dim;
        return { kind: 'text', name: names[L] ?? `Level ${L + 1}` };
      }
      const search = (axis, level) => (q, signal) => source.getFilterValues({ axis, level, search: q, limit: FILTER_VALUES_LIMIT, query: EMPTY_QUERY, signal });
      if (key.cdim !== undefined) return { kind: 'values', name: colLevelNames[key.cdim] ?? `Column level ${key.cdim + 1}`, search: search('cols', key.cdim) };
      const name = bandNames[key.dim] ?? `Level ${key.dim + 1}`;
      if (key.dim >= meta.rows.levels.length) return { kind: 'text', name };
      return { kind: 'values', name, search: search('rows', key.dim) };
    },
    reload: ({ query }) => model.applyView({ colfilter: currentColFilter, query }),
    async applyView({ colfilter = '', query }) {
      if (typeof source.getLayout !== 'function') throw new Error('this data source cannot sort or filter a pivot (no getLayout)');
      const res = await source.getLayout({ query });
      if (colfilter !== currentColFilter) {
        // New column layout: keep collapsed column groups (by original id); widths start fresh.
        const originalCol = (L, i) => (colMaps ? colMaps[L][i] : i);
        const collapsedCols = colTree.collapsed.map((flags, L) => {
          const set = new Set();
          flags.forEach((v, i) => { if (v) set.add(originalCol(L, i)); });
          return set;
        });
        const nextCols = new TreeAxis(res.cols);
        const maps = res.colMaps ?? null;
        nextCols.setCollapsedWhere((L, i) => collapsedCols[L].has(maps ? maps[L][i] : i));
        colTree = nextCols;
        colMaps = maps;
        cols = new ResizableAxis(colTree);
        model.cols = cols;
        model.colSourceCount = colTree.fullCount;
        currentColFilter = colfilter;
      }
      // Keep expanded/collapsed groups: remember them by original group id, re-apply in the new order.
      const original = (L, i) => (rowMaps ? rowMaps[L][i] : i);
      const collapsed = rowTree.collapsed.map((flags, L) => {
        const set = new Set();
        flags.forEach((v, i) => { if (v) set.add(original(L, i)); });
        return set;
      });
      const next = new TreeAxis(res.rows);
      const maps = res.rowMaps ?? null;
      next.setCollapsedWhere((L, i) => collapsed[L].has(maps ? maps[L][i] : i));
      rowTree = next;
      rowMaps = maps;
      model.rows = next;
      model.rowSourceCount = next.fullCount;
    },
  };
  return model;
}

/**
 * Header segments for a TreeAxis. Band L shows level-L groups, spanning all their items except their
 * own subtotal. A level-L subtotal spans bands L..depth ("France total"), while outer bands keep showing
 * the enclosing groups. A collapsed group is one item spanning bands L..depth. Leaves fill the last band;
 * the grand total spans every band.
 */
function treeSegments(tree, axis, a, b, label, sortable = false) {
  const D = tree.depth;
  const out = [];
  // Single-column header segments (months, subtotals, collapsed groups) are sortable by that column.
  const sortOf = (i) => (sortable ? { col: tree.sourceOf(i) } : undefined);
  for (let L = 0; L < D; L++) {
    const hasSub = tree.sub[L];
    const collapsible = tree.canCollapse(L);
    tree.forEachGroup(L, a, b, (g, first, last) => {
      const name = label(axis, L, g);
      if (collapsible && tree.isCollapsed(L, g)) {
        out.push({
          key: `c${L}:${g}`, a: first, b: first, t0: L, t1: D,
          label: name === undefined ? undefined : `▸ ${name}`,
          cls: `vg-sub vg-sub${L} vg-collapsed`, resizable: true, sort: sortOf(first),
          toggle: { axis, level: L, group: g, collapsed: true },
        });
        return;
      }
      const spanEnd = hasSub ? last - 1 : last;
      if (spanEnd >= first && spanEnd >= a) {
        out.push({
          key: `g${L}:${g}`, a: first, b: spanEnd, t0: L, t1: L,
          label: name === undefined || !collapsible ? name : `▾ ${name}`,
          cls: `vg-group vg-lv${L}`,
          toggle: collapsible ? { axis, level: L, group: g, collapsed: false } : undefined,
        });
      }
      if (hasSub && last <= b) {
        out.push({ key: `s${L}:${g}`, a: last, b: last, t0: L, t1: D, label: name === undefined ? undefined : `${name} total`, cls: `vg-sub vg-sub${L}`, resizable: true, sort: sortOf(last) });
      }
      if (L === D - 1) {
        const leafBase = tree.childStart[L][g];
        const lo = Math.max(first, a);
        const hi = Math.min(spanEnd, b);
        for (let i = lo; i <= hi; i++) {
          out.push({ key: `l${i}`, a: i, b: i, t0: D, t1: D, label: label(axis, D, leafBase + (i - first)), cls: 'vg-leaf', resizable: true, sort: sortOf(i), filter: sortable ? { cdim: D } : undefined });
        }
      }
    });
  }
  if (tree.grandTotal && tree.grandIndex >= a && tree.grandIndex <= b) {
    out.push({ key: 'G', a: tree.grandIndex, b: tree.grandIndex, t0: 0, t1: D, label: 'Grand total', cls: 'vg-grand', resizable: true });
  }
  return out;
}
