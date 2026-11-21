// A pivot: row and column trees (TreeAxis) from the data source's layout, with grouped headers,
// subtotals and expand / collapse. Sorting and filtering are done by the data source, which returns
// the reordered (and, for column filters, renumbered) trees.

import { ResizableAxis } from '../axes/resizable.js';
import { TreeAxis } from '../axes/tree.js';
import { EMPTY_QUERY } from '../query.js';
import type { DataSource, PivotLayout } from '../types.js';
import { FILTER_VALUES_LIMIT, type ModelOptions } from './table.js';
import type { AxisName, ColumnInfo, FilterDescription, GridModel, InitialView, LabelLookup, Segment, ValueSearch } from './types.js';

const DEFAULT_ROW_BAND_WIDTHS = [136, 132, 124, 176];

export interface PivotModel extends GridModel {
  rows: TreeAxis;
  cols: ResizableAxis<TreeAxis>;
}

/** Per level, the original ids of the collapsed groups (to restore them in a reordered tree). */
function collapsedIds(tree: TreeAxis, maps: number[][] | null): Set<number>[] {
  return tree.collapsed.map((flags, L) => {
    const set = new Set<number>();
    flags.forEach((v, i) => {
      if (v) set.add(maps ? maps[L][i] : i);
    });
    return set;
  });
}

/** A new tree for a new layout, with the same groups (by original id) collapsed. */
function rebuildTree(prev: TreeAxis, prevMaps: number[][] | null, spec: PivotLayout['rows'], maps: number[][] | null): TreeAxis {
  const collapsed = collapsedIds(prev, prevMaps);
  const next = new TreeAxis(spec);
  next.setCollapsedWhere((L, i) => collapsed[L].has(maps ? maps[L][i] : i));
  return next;
}

export function createPivotModel(meta: PivotLayout, source: DataSource, options: ModelOptions = {}, initial: InitialView = {}): PivotModel {
  let rowTree = new TreeAxis(meta.rows);
  let rowMaps = meta.rowMaps ?? null; // per level: sorted group index -> original group index (null = unsorted)
  let colTree = new TreeAxis(meta.cols);
  let cols = new ResizableAxis(colTree);
  let colMaps = meta.colMaps ?? null; // per column level: displayed group -> original group (null = unfiltered)
  let currentColFilter = initial.colfilter ?? '';
  const colLevelNames = [...meta.cols.levels.map((l) => l.name), meta.cols.leafName];
  const bandNames = [...meta.rows.levels.map((l) => l.name), meta.rows.leafName];
  const bandWidths = options.rowHeaderWidths ?? DEFAULT_ROW_BAND_WIDTHS;
  const treeOf = (axis: AxisName) => (axis === 'rows' ? rowTree : colTree);
  const changed = (axis: AxisName) => {
    if (axis === 'cols') cols.refresh(); // column widths are kept by source index
  };

  const kind = (tree: TreeAxis, i: number) => {
    const loc = tree.locate(i);
    if (loc.kind === 'leaf') return '';
    if (loc.kind === 'grand') return ' vg-grand';
    return ` vg-sub vg-sub${loc.level}${loc.kind === 'collapsed' ? ' vg-collapsed' : ''}`;
  };

  const cellInfo: ColumnInfo = { column: undefined, format: options.format, cellClass: options.cellClass, renderCell: options.renderCell, cls: '' };

  const model: PivotModel = {
    hostClass: 'vg-pivot',
    totalRows: undefined,
    rows: rowTree,
    cols,
    rowBands: bandNames.map((name, i) => ({ name, width: bandWidths[i] ?? 128 })),
    colTiers: colLevelNames.map((name) => ({ name, height: 28 })),
    rowKind: (r) => kind(rowTree, r) || (r % 2 === 1 ? ' vg-odd' : ''),
    colKind: (c) => kind(colTree, c),
    rowSegments: (a, b, label) => treeSegments(rowTree, 'rows', a, b, label),
    colSegments: (a, b, label) => treeSegments(colTree, 'cols', a, b, label, true),
    columnInfo: () => cellInfo,

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
    // a row dimension's names. The data source returns the reordered row layout.
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
      const visible = colTree.fromSource(key.col!, true);
      const loc = colTree.locate(visible);
      const parts = loc.path.map((g, L) => label('cols', L, g) ?? '…');
      if (loc.kind === 'leaf') parts.push(label('cols', colTree.depth, loc.leaf) ?? '…');
      else parts[parts.length - 1] += ' total';
      return parts.join(' · ');
    },
    // Dimension names come from the data source's distinct-value search (unfiltered data, first 1000 that
    // match), so a 20,000-year or million-city list opens at once. Products are filtered by text.
    filterOptions(key): FilterDescription {
      if (typeof source.getFilterValues !== 'function') {
        // Without a value list, dimensions are filtered by text.
        const names = key.cdim !== undefined ? colLevelNames : bandNames;
        const L = (key.cdim ?? key.dim)!;
        return { kind: 'text', name: names[L] ?? `Level ${L + 1}` };
      }
      const getFilterValues = source.getFilterValues.bind(source);
      const search = (axis: AxisName, level: number): ValueSearch => (q, signal) =>
        getFilterValues({ axis, level, search: q, limit: FILTER_VALUES_LIMIT, query: EMPTY_QUERY, signal });
      if (key.cdim !== undefined) return { kind: 'values', name: colLevelNames[key.cdim] ?? `Column level ${key.cdim + 1}`, search: search('cols', key.cdim) };
      const dim = key.dim!;
      const name = bandNames[dim] ?? `Level ${dim + 1}`;
      if (dim >= meta.rows.levels.length) return { kind: 'text', name };
      return { kind: 'values', name, search: search('rows', dim) };
    },
    reload: ({ query, sort, filter }) => model.applyView!({ sort, filter, colfilter: currentColFilter, query }),
    async applyView({ colfilter = '', query, signal, onProgress }) {
      if (typeof source.getLayout !== 'function') throw new Error('this data source cannot sort or filter a pivot (no getLayout)');
      const res = (await source.getLayout({ query, signal, onProgress })) as PivotLayout;
      if (colfilter !== currentColFilter) {
        // New column layout: keep collapsed column groups (by original id); widths start fresh.
        const maps = res.colMaps ?? null;
        colTree = rebuildTree(colTree, colMaps, res.cols, maps);
        colMaps = maps;
        cols = new ResizableAxis(colTree);
        model.cols = cols;
        model.colSourceCount = colTree.fullCount;
        currentColFilter = colfilter;
      }
      // Keep expanded/collapsed groups: remember them by original group id, re-apply in the new order.
      const maps = res.rowMaps ?? null;
      rowTree = rebuildTree(rowTree, rowMaps, res.rows, maps);
      rowMaps = maps;
      model.rows = rowTree;
      model.rowSourceCount = rowTree.fullCount;
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
function treeSegments(tree: TreeAxis, axis: AxisName, a: number, b: number, label: LabelLookup, sortable = false): Segment[] {
  const D = tree.depth;
  const out: Segment[] = [];
  // Single-column header segments (months, subtotals, collapsed groups) are sortable by that column.
  const sortOf = (i: number) => (sortable ? { col: tree.sourceOf(i) } : undefined);
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
