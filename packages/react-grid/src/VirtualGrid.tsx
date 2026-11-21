// The <VirtualGrid> component: props -> core options, a core grid per mount, and React content
// (cells, headers, filters, the empty state) rendered with portals into the grid's own elements, so it
// shares your context. Only structural changes rebuild the grid; new functions just redraw the visible
// cells. Sort / filter / columnFilter / selectedCells are controlled when passed, uncontrolled otherwise.

import {
  forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type Ref,
} from 'react';
import { createArraySource, createGrid, type Grid, type GridOptions } from '@borealjs/grid-core';
import { collectColumns, toCoreColumn, useCoreColumns } from './columns.js';
import { createPortalStore, Portals } from './portals.js';
import type { VirtualGridProps } from './types.js';

const useIsoLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

type Props = VirtualGridProps<any>;

/** Event callbacks: stable wrappers that call the latest prop. */
const CALLBACKS = [
  'onSortChange', 'onFilterChange', 'onColumnFilterChange', 'onSelectionChange', 'onCopy', 'onError', 'onViewChange', 'onColumnResize', 'onReady',
  'onRowSelectionChange', 'onCellClick', 'onCellDoubleClick', 'onCellContextMenu', 'onColumnOrderChange',
] as const satisfies readonly (keyof Props & keyof GridOptions)[];
/** Props passed to the core as they are. */
const PASS = [
  'layout', 'rowCount', 'columnCount', 'rowHeight', 'headerHeight', 'columnWidth', 'minColumnWidth',
  'columnChooser', 'columnGroups', 'theme', 'sortable', 'filterable', 'resizable', 'multiSort', 'expandable',
  'selection', 'copy', 'keyboard', 'notices', 'defaultSort', 'defaultFilter', 'defaultColumnFilter', 'blockRows', 'blockCols',
  'rowHeaderWidths', 'model', 'isMac', 'rowSelection', 'reorderable', 'pinnedColumns', 'pinnedColumnsRight',
] as const satisfies readonly (keyof Props & keyof GridOptions)[];
/** Object props compared shallowly, so inline objects do not rebuild the grid. */
const OBJECTS = ['rowHeader', 'messages'] as const satisfies readonly (keyof Props & keyof GridOptions)[];
const QUERY = ['sort', 'filter', 'columnFilter'] as const satisfies readonly (keyof Props & keyof GridOptions)[];
/** Array / object props compared by content (a new array with the same items is no change). */
const BY_CONTENT = ['selectedRows', 'columnOrder'] as const satisfies readonly (keyof Props & keyof GridOptions)[];

const shallowEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
};

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Keeps the previous object while it is shallowly equal. */
function useShallowStable<T>(value: T): T {
  const ref = useRef(value);
  if (!shallowEqual(ref.current, value)) ref.current = value;
  return ref.current;
}

function VirtualGridImpl(props: Props, ref: Ref<Grid | null>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<Grid | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [store] = useState(createPortalStore);

  const list = collectColumns(props.columns, props.children);
  const { core: columns, fnVersion } = useCoreColumns(list, store);
  const getColumn = useMemo(() => (props.getColumn ? (i: number) => toCoreColumn(props.getColumn!(i), store) : undefined), [props.getColumn, store]);
  // Each object prop on its own: an inline `messages={{ … }}` with the same entries is no change.
  const stableObjects = { rowHeader: useShallowStable(props.rowHeader), messages: useShallowStable(props.messages) } satisfies Record<(typeof OBJECTS)[number], unknown>;

  // In-memory rows: one source per column structure; new `rows` arrays go in with setRows + refresh.
  const filterFnsRef = useRef(props.filterFns);
  filterFnsRef.current = props.filterFns;
  const useRows = !props.dataSource && !!props.rows;
  const rowsSource = useMemo(() => {
    if (!useRows) return undefined;
    const filterFns = new Proxy({}, { get: (_, op: string) => filterFnsRef.current?.[op] });
    return createArraySource(propsRef.current.rows as unknown[], { columns, filterFns });
  }, [useRows, columns]);
  const dataSource = props.dataSource ?? rowsSource ?? null;

  // Grid-wide hooks: stable functions reading the latest props (presence changes rebuild the grid).
  const has = (k: keyof Props) => props[k] !== undefined && props[k] !== null && props[k] !== false;
  const hooks = useMemo((): Partial<GridOptions> => ({
    format: has('format') ? (v, ctx) => propsRef.current.format?.(v, ctx as never) ?? '' : undefined,
    cellClass: has('cellClass') ? (v, ctx) => propsRef.current.cellClass?.(v, ctx as never) : undefined,
    rowClass: has('rowClass') ? (r) => propsRef.current.rowClass?.(r) : undefined,
    renderCell: has('renderCell') ? (el, ctx) => store.set(el, propsRef.current.renderCell?.(ctx as never)) : undefined,
    renderHeader: has('renderHeader') ? (el, ctx) => store.set(el, propsRef.current.renderHeader?.(ctx)) : undefined,
    renderEmpty: has('emptyState')
      ? (el, ctx) => {
        const e = propsRef.current.emptyState;
        return store.set(el, typeof e === 'function' ? e(ctx) : e);
      }
      : undefined,
  }), [has('format'), has('cellClass'), has('rowClass'), has('renderCell'), has('renderHeader'), has('emptyState'), store]); // eslint-disable-line react-hooks/exhaustive-deps
  const callbacks = useMemo(
    () => Object.fromEntries(CALLBACKS.map((k) => [k, (...args: unknown[]) => (propsRef.current[k] as ((...a: unknown[]) => void) | undefined)?.(...args)])),
    [],
  );
  // Only callbacks that are set count as handlers (a cell click handler changes how clicks behave).
  const handlers = Object.fromEntries(CALLBACKS.map((k) => [k, props[k] ? callbacks[k] : undefined]));
  const hasRowId = typeof props.getRowId === 'function';
  const getRowId = useMemo(() => (hasRowId ? (row: unknown) => propsRef.current.getRowId!(row as never) : undefined), [hasRowId]);
  // sortable / filterable may be functions of the column or level: keep them stable like the hooks.
  const isFn = (k: 'sortable' | 'filterable') => typeof props[k] === 'function';
  const rules = useMemo(() => ({
    sortable: isFn('sortable') ? (target: never) => (propsRef.current.sortable as (t: never) => boolean)?.(target) : undefined,
    filterable: isFn('filterable') ? (target: never) => (propsRef.current.filterable as (t: never) => boolean)?.(target) : undefined,
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
    ...handlers,
    getRowId,
    selectedRows: props.selectedRows,
    columnOrder: props.columnOrder,
    // Controlled when the prop is given: the grid reports changes and waits for the new prop.
    sort: props.sort,
    filter: props.filter,
    columnFilter: props.columnFilter,
    controlled: { sort: props.sort !== undefined, filter: props.filter !== undefined, columnFilter: props.columnFilter !== undefined },
  } as GridOptions;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const ready = !!(dataSource || props.model);
  useIsoLayoutEffect(() => {
    if (!ready) return undefined;
    const grid = createGrid(hostRef.current!, optionsRef.current);
    gridRef.current = grid;
    grid.ready.catch(() => {}); // reported through onError
    return () => {
      grid.destroy();
      gridRef.current = null;
    };
  }, [ready]);

  useImperativeHandle(ref, () => gridRef.current!, [ready]);

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
    const next = { ...optionsRef.current } as Record<string, unknown> & GridOptions;
    // Controlled queries compare by content (a new array with the same items is no change).
    for (const k of QUERY) if (next[k] !== undefined && sameJson(next[k], grid.getQuery()[k])) next[k] = prev[k] as never;
    for (const k of BY_CONTENT) if (sameJson(next[k], prev[k])) next[k] = prev[k] as never;
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
    rowsSource.setRows(props.rows as unknown[]);
    void gridRef.current?.refresh();
  }, [props.rows, rowsSource]);

  // useDataSource: its dependencies changed -> reload (same source object, new version).
  const version = (props.dataSource as { version?: number } | undefined)?.version;
  const lastVersion = useRef(version);
  useEffect(() => {
    if (lastVersion.current === version) return;
    lastVersion.current = version;
    void gridRef.current?.refresh();
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
  return (
    <>
      <div className={className} style={{ position: 'relative', minHeight: 0, ...style }} id={id}>
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      </div>
      <Portals store={store} />
    </>
  );
}

/**
 * The grid. Give it a size (CSS height, or a flex child with min-height: 0).
 * `sort` / `filter` / `columnFilter` / `selectedCells` are controlled when passed (update them from the
 * on…Change callbacks); use defaultSort etc. for uncontrolled state. The ref is the core Grid API.
 */
export const VirtualGrid = forwardRef(VirtualGridImpl) as unknown as (<Row = any>(props: VirtualGridProps<Row>) => ReactElement | null) & { displayName?: string };
VirtualGrid.displayName = 'VirtualGrid';
