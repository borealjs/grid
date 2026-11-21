'use client';
// @borealjs/react-grid — React bindings for @borealjs/grid-core.
//
//   <VirtualGrid rows={data} columns={columns} />                       in-memory rows
//   <VirtualGrid dataSource={useDataSource({ getCells, … }, deps)} />    your backend
//   <VirtualGrid rows={data}><Column field="name" title="Name" /></VirtualGrid>
//
// React content (cells, headers, filters, the empty state) is rendered with portals into the grid's own
// elements, so it shares your context. Inline functions are fine: only structural column changes rebuild
// the grid; new functions just redraw the visible cells. Sort / filter / columnFilter / selectedCells are
// controlled when passed, uncontrolled otherwise. The ref is the core Grid API.
//
// Written without JSX so the package ships as plain ES modules with no build step.

import {
  Children, createElement, forwardRef, Fragment, isValidElement, useEffect, useImperativeHandle, useLayoutEffect,
  useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { createGrid, createArraySource, createHttpSource } from '@borealjs/grid-core';

export { createArraySource, createHttpSource };

const useIsoLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

// ------------------------------------------------------------------ portal store

/**
 * Elements the grid asked React to fill: element -> React node. The grid calls set() when a cell or
 * header changes and the returned cleanup when it goes back to text or is reused; updates are batched
 * into one React render per frame (a microtask after the grid's own frame, before paint).
 */
function createPortalStore() {
  const nodes = new Map();
  const ids = new WeakMap();
  const listeners = new Set();
  let seq = 0;
  let snapshot = [];
  let queued = false;
  const flush = () => {
    queued = false;
    snapshot = Array.from(nodes, ([el, node]) => [el, node, ids.get(el)]);
    for (const l of listeners) l();
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(flush);
  };
  return {
    set(el, node) {
      if (!ids.has(el)) ids.set(el, `p${seq++}`);
      nodes.set(el, node);
      schedule();
      return () => {
        if (nodes.get(el) === node) {
          nodes.delete(el);
          schedule();
        }
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}

const EMPTY = [];
const emptySnapshot = () => EMPTY;

function Portals({ store }) {
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot, emptySnapshot);
  return entries.map(([el, node, key]) => createPortal(node, el, key));
}

// ------------------------------------------------------------------ columns

/**
 * Declares a column as JSX: <Column field="amount" title="Amount" type="number" renderCell={…} />.
 * Takes the same props as a column object. Renders nothing itself.
 */
export function Column() {
  return null;
}
Column.displayName = 'Column';

const withKey = (d) => (d && d.field !== undefined && d.key === undefined ? { ...d, key: d.field } : d);

/** Column objects from <Column> children, else the `columns` prop (`field` is an alias of `key`). */
function collectColumns(columns, children) {
  const fromChildren = [];
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.type === Column) fromChildren.push(child.props);
  });
  const list = fromChildren.length ? fromChildren : columns;
  return list?.map(withKey);
}

const FN_PROPS = ['format', 'cellClass', 'renderCell', 'renderHeader', 'value', 'compare'];

/** What decides the grid's structure: everything except function identities (their presence counts). */
function columnSignature(list) {
  if (!list) return '';
  return JSON.stringify(list, (k, v) => (typeof v === 'function' ? 'ƒ' : k === 'children' ? undefined : v));
}

/**
 * Stable core columns, rebuilt only when the structure changes. Their functions call the latest ones,
 * so inline functions are fine; when any function identity changes, `fnVersion` moves (redraw cells).
 */
function useCoreColumns(list, store) {
  const latest = useRef(list);
  latest.current = list;
  const sig = columnSignature(list);
  const core = useMemo(() => list?.map((d, i) => {
    const out = { ...d };
    for (const p of FN_PROPS) {
      if (typeof d[p] !== 'function') continue;
      if (p === 'renderCell' || p === 'renderHeader') out[p] = (el, ctx) => store.set(el, latest.current[i][p](ctx));
      else out[p] = (...args) => latest.current[i][p](...args);
    }
    if (d.filter && typeof d.filter === 'object' && typeof d.filter.render === 'function') {
      out.filter = { ...d.filter, render: (el, api) => store.set(el, latest.current[i].filter.render(api)) };
    }
    return out;
  }), [sig, store]); // eslint-disable-line react-hooks/exhaustive-deps
  const fns = list ? list.flatMap((d) => [...FN_PROPS.map((p) => d[p]), d.filter?.render]) : EMPTY;
  const prevFns = useRef(fns);
  const version = useRef(0);
  if (fns.length !== prevFns.current.length || fns.some((f, i) => f !== prevFns.current[i])) {
    prevFns.current = fns;
    version.current++;
  }
  return { core, fnVersion: version.current };
}

/** A React column -> core column, for getColumn (very wide tables). */
function toCoreColumn(d, store) {
  if (!d) return d;
  const out = { ...withKey(d) };
  if (typeof d.renderCell === 'function') out.renderCell = (el, ctx) => store.set(el, d.renderCell(ctx));
  if (typeof d.renderHeader === 'function') out.renderHeader = (el, ctx) => store.set(el, d.renderHeader(ctx));
  if (d.filter && typeof d.filter === 'object' && typeof d.filter.render === 'function') {
    out.filter = { ...d.filter, render: (el, api) => store.set(el, d.filter.render(api)) };
  }
  return out;
}

/**
 * Column helpers (typed in TypeScript from the row type):
 *   const col = createColumnHelper();
 *   col.field('amount', { format: (v) => v.toFixed(2) });  col.computed('total', (row) => row.a + row.b);
 */
export function createColumnHelper() {
  return {
    field: (field, def = {}) => ({ ...def, field }),
    computed: (field, value, def = {}) => ({ ...def, field, value }),
  };
}

// ------------------------------------------------------------------ props -> core options

const CALLBACKS = ['onSortChange', 'onFilterChange', 'onColumnFilterChange', 'onSelectionChange', 'onCopy', 'onError', 'onViewChange', 'onColumnResize', 'onReady'];
const PASS = [
  'layout', 'rowCount', 'columnCount', 'rowHeight', 'headerHeight', 'columnWidth', 'minColumnWidth',
  'columnChooser', 'columnGroups', 'theme', 'sortable', 'filterable', 'resizable', 'multiSort', 'expandable',
  'selection', 'copy', 'keyboard', 'notices', 'defaultSort', 'defaultFilter', 'defaultColumnFilter', 'blockRows', 'blockCols',
  'rowHeaderWidths', 'model',
];
const OBJECTS = ['rowHeader', 'messages'];
const QUERY = ['sort', 'filter', 'columnFilter'];

const shallowEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

const sameJson = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Keeps the previous object while it is shallowly equal, so inline objects do not rebuild the grid. */
function useShallowStable(value) {
  const ref = useRef(value);
  if (!shallowEqual(ref.current, value)) ref.current = value;
  return ref.current;
}

// ------------------------------------------------------------------ component

export const VirtualGrid = forwardRef(function VirtualGrid(props, ref) {
  const hostRef = useRef(null);
  const gridRef = useRef(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [store] = useState(createPortalStore);

  const list = collectColumns(props.columns, props.children);
  const { core: columns, fnVersion } = useCoreColumns(list, store);
  const getColumn = useMemo(() => (props.getColumn ? (i) => toCoreColumn(props.getColumn(i), store) : undefined), [props.getColumn, store]);
  const stableObjects = useShallowStable(Object.fromEntries(OBJECTS.map((k) => [k, props[k]])));

  // In-memory rows: one source per column structure; new `rows` arrays go in with setRows + refresh.
  const filterFnsRef = useRef(props.filterFns);
  filterFnsRef.current = props.filterFns;
  const useRows = !props.dataSource && !!props.rows;
  const rowsSource = useMemo(() => {
    if (!useRows) return undefined;
    const filterFns = new Proxy({}, { get: (_, op) => filterFnsRef.current?.[op] });
    return createArraySource(propsRef.current.rows, { columns, filterFns });
  }, [useRows, columns]);
  const dataSource = props.dataSource ?? rowsSource ?? null;

  // Grid-wide hooks: stable functions reading the latest props (presence changes rebuild the grid).
  const has = (k) => props[k] !== undefined && props[k] !== null && props[k] !== false;
  const hooks = useMemo(() => ({
    format: has('format') ? (v, ctx) => propsRef.current.format?.(v, ctx) : undefined,
    cellClass: has('cellClass') ? (v, ctx) => propsRef.current.cellClass?.(v, ctx) : undefined,
    rowClass: has('rowClass') ? (r) => propsRef.current.rowClass?.(r) : undefined,
    renderCell: has('renderCell') ? (el, ctx) => store.set(el, propsRef.current.renderCell?.(ctx)) : undefined,
    renderHeader: has('renderHeader') ? (el, ctx) => store.set(el, propsRef.current.renderHeader?.(ctx)) : undefined,
    renderEmpty: has('emptyState')
      ? (el, ctx) => {
        const e = propsRef.current.emptyState;
        return store.set(el, typeof e === 'function' ? e(ctx) : e);
      }
      : undefined,
  }), [has('format'), has('cellClass'), has('rowClass'), has('renderCell'), has('renderHeader'), has('emptyState'), store]); // eslint-disable-line react-hooks/exhaustive-deps
  const callbacks = useMemo(() => Object.fromEntries(CALLBACKS.map((k) => [k, (...args) => propsRef.current[k]?.(...args)])), []);
  // sortable / filterable may be functions of the column or level: keep them stable like the hooks.
  const isFn = (k) => typeof props[k] === 'function';
  const rules = useMemo(() => ({
    sortable: isFn('sortable') ? (target) => propsRef.current.sortable?.(target) : undefined,
    filterable: isFn('filterable') ? (target) => propsRef.current.filterable?.(target) : undefined,
  }), [isFn('sortable'), isFn('filterable')]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = {
    ...Object.fromEntries(PASS.map((k) => [k, props[k]])),
    ...stableObjects,
    ...(rules.sortable && { sortable: rules.sortable }),
    ...(rules.filterable && { filterable: rules.filterable }),
    ariaLabel: props['aria-label'],
    dataSource,
    columns,
    getColumn,
    ...hooks,
    ...callbacks,
    // Controlled when the prop is given: the grid reports changes and waits for the new prop.
    sort: props.sort,
    filter: props.filter,
    columnFilter: props.columnFilter,
    controlled: { sort: props.sort !== undefined, filter: props.filter !== undefined, columnFilter: props.columnFilter !== undefined },
  };
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const ready = !!(dataSource || props.model);
  useIsoLayoutEffect(() => {
    if (!ready) return undefined;
    const grid = createGrid(hostRef.current, optionsRef.current);
    gridRef.current = grid;
    grid.ready.catch(() => {}); // reported through onError
    return () => {
      grid.destroy();
      gridRef.current = null;
    };
  }, [ready]);

  useImperativeHandle(ref, () => gridRef.current, [ready]);

  // Later renders: hand the grid what changed (it decides between redraw, query change and rebuild).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const grid = gridRef.current;
    if (!grid) return;
    const prev = grid.options;
    const next = { ...optionsRef.current };
    // Controlled queries compare by content (a new array with the same items is no change).
    for (const k of QUERY) if (next[k] !== undefined && sameJson(next[k], grid.getQuery()[k])) next[k] = prev[k];
    if (shallowEqual(next.controlled, prev.controlled)) next.controlled = prev.controlled;
    grid.setOptions(next).catch(() => {});
  });

  // New functions in columns (same structure): redraw what is visible.
  const lastFnVersion = useRef(fnVersion);
  useEffect(() => {
    if (lastFnVersion.current === fnVersion) return;
    lastFnVersion.current = fnVersion;
    gridRef.current?.repaint();
  }, [fnVersion]);

  // New rows for the in-memory source: keep scroll, sort and filter, reload what is visible.
  useEffect(() => {
    if (!rowsSource || rowsSource.rows === props.rows) return;
    rowsSource.setRows(props.rows);
    gridRef.current?.refresh();
  }, [props.rows, rowsSource]);

  // useDataSource: its dependencies changed -> reload (same source object, new version).
  const version = props.dataSource?.version;
  const lastVersion = useRef(version);
  useEffect(() => {
    if (lastVersion.current === version) return;
    lastVersion.current = version;
    gridRef.current?.refresh();
  }, [version]);

  // Controlled selection: apply when it differs from the grid's.
  const selected = props.selectedCells;
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !selected) return;
    const apply = () => {
      const cur = grid.getSelection();
      const want = { active: selected.active ?? cur?.active, ranges: selected.ranges ?? cur?.ranges };
      if (!cur || !sameJson({ active: cur.active, ranges: cur.ranges }, want)) grid.setSelection(selected);
    };
    if (grid.engine) apply();
    else grid.ready.then(apply, () => {});
  }, [selected]);

  const { className, style, id } = props;
  return createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className, style: { position: 'relative', minHeight: 0, ...style }, id },
      createElement('div', { ref: hostRef, style: { position: 'absolute', inset: 0 } }),
    ),
    createElement(Portals, { store }),
  );
});
VirtualGrid.displayName = 'VirtualGrid';

// ------------------------------------------------------------------ hooks

/**
 * A data source from callbacks that may close over props and state. It stays the same object (the grid
 * is not rebuilt); when `deps` change, the grid reloads what is visible, keeping scroll, sort and filter.
 *
 *   const source = useDataSource({
 *     getLayout: async ({ query, signal }) => ({ rowCount: await api.count(search, query, signal) }),
 *     getCells: ({ rects, query, signal }) => api.cells(search, rects, query, signal),
 *   }, [search]);
 */
export function useDataSource(spec, deps = []) {
  const ref = useRef(spec);
  ref.current = spec;
  const [source] = useState(() => {
    const s = { version: 0 };
    for (const name of ['getCells', 'getLayout', 'getLabels', 'getFilterValues', 'rowAt']) {
      if (typeof spec[name] === 'function') s[name] = (...args) => ref.current[name](...args);
    }
    for (const name of ['maxRectsPerRequest', 'maxCellsPerRequest']) if (spec[name] !== undefined) s[name] = spec[name];
    return s;
  });
  const prevDeps = useRef(deps);
  if (deps.length !== prevDeps.current.length || deps.some((d, i) => !Object.is(d, prevDeps.current[i]))) {
    prevDeps.current = deps;
    source.version++;
  }
  return source;
}

/** An in-memory data source that stays the same object while `rows` and the options do. */
export function useArraySource(rows, options) {
  const { columns, filterFns, compare } = options ?? {};
  return useMemo(() => createArraySource(rows, { columns, filterFns, compare }), [rows, columns, filterFns, compare]);
}
