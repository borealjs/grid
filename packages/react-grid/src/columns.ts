import { Children, isValidElement, useMemo, useRef, type ReactNode } from 'react';
import type { ColumnDef as CoreColumnDef, CustomFilter } from '@borealjs/grid-core';
import type { PortalStore } from './portals.js';
import type { ColumnDef } from './types.js';

/**
 * Declares a column as JSX: <Column field="amount" title="Amount" type="number" renderCell={…} />.
 * Takes the same props as a column object. Renders nothing itself.
 */
export function Column<Row = any, F extends Extract<keyof Row, string> | (string & {}) = string>(_props: ColumnDef<Row, F>): null {
  return null;
}
Column.displayName = 'Column';

type AnyColumn = ColumnDef<any, string, any>;

const withKey = (d: AnyColumn): AnyColumn => (d && d.field !== undefined && d.key === undefined ? { ...d, key: d.field } : d);

/** Column objects from <Column> children, else the `columns` prop (`field` is an alias of `key`). */
export function collectColumns(columns: readonly AnyColumn[] | undefined, children: ReactNode): AnyColumn[] | undefined {
  const fromChildren: AnyColumn[] = [];
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.type === Column) fromChildren.push(child.props as AnyColumn);
  });
  const list = fromChildren.length ? fromChildren : columns;
  return list?.map(withKey);
}

/** Function props of a column: wrapped so the latest function is always called. */
const FN_PROPS = ['format', 'cellClass', 'renderCell', 'renderHeader', 'value', 'compare'] as const;

const customFilterOf = (d: AnyColumn) => (d.filter && typeof d.filter === 'object' && typeof (d.filter as { render?: unknown }).render === 'function'
  ? (d.filter as { op?: string; render(api: unknown): ReactNode })
  : null);

/** What decides the grid's structure: everything except function identities (their presence counts). */
function columnSignature(list: readonly AnyColumn[] | undefined): string {
  if (!list) return '';
  return JSON.stringify(list, (k, v) => (typeof v === 'function' ? 'ƒ' : k === 'children' ? undefined : v));
}

/**
 * Stable core columns, rebuilt only when the structure changes. Their functions call the latest ones,
 * so inline functions are fine; when any function identity changes, `fnVersion` moves (redraw cells).
 */
export function useCoreColumns(list: AnyColumn[] | undefined, store: PortalStore): { core: CoreColumnDef[] | undefined; fnVersion: number } {
  const latest = useRef(list);
  latest.current = list;
  const sig = columnSignature(list);
  const core = useMemo(() => list?.map((d, i) => {
    const out: Record<string, unknown> = { ...d };
    const at = () => latest.current![i] as Record<string, (...args: any[]) => any>;
    for (const p of FN_PROPS) {
      if (typeof d[p] !== 'function') continue;
      if (p === 'renderCell' || p === 'renderHeader') out[p] = (el: HTMLElement, ctx: unknown) => store.set(el, at()[p](ctx));
      else out[p] = (...args: unknown[]) => at()[p](...args);
    }
    const custom = customFilterOf(d);
    if (custom) {
      out.filter = { ...custom, render: (el: HTMLElement, api: unknown) => store.set(el, customFilterOf(latest.current![i])!.render(api)) } satisfies CustomFilter;
    }
    return out as CoreColumnDef;
  }), [sig, store]); // eslint-disable-line react-hooks/exhaustive-deps
  const fns: unknown[] = list ? list.flatMap((d) => [...FN_PROPS.map((p) => d[p]), customFilterOf(d)?.render]) : [];
  const prevFns = useRef(fns);
  const version = useRef(0);
  if (fns.length !== prevFns.current.length || fns.some((f, i) => f !== prevFns.current[i])) {
    prevFns.current = fns;
    version.current++;
  }
  return { core, fnVersion: version.current };
}

/** A React column -> core column, for getColumn (very wide tables). */
export function toCoreColumn(d: AnyColumn | undefined, store: PortalStore): CoreColumnDef {
  if (!d) return d as unknown as CoreColumnDef;
  const out: Record<string, unknown> = { ...withKey(d) };
  const { renderCell, renderHeader } = d;
  if (typeof renderCell === 'function') out.renderCell = (el: HTMLElement, ctx: any) => store.set(el, renderCell(ctx));
  if (typeof renderHeader === 'function') out.renderHeader = (el: HTMLElement, ctx: any) => store.set(el, renderHeader(ctx));
  const custom = customFilterOf(d);
  if (custom) out.filter = { ...custom, render: (el: HTMLElement, api: unknown) => store.set(el, custom.render(api)) };
  return out as CoreColumnDef;
}

export interface ColumnHelper<Row> {
  field<F extends Extract<keyof Row, string>>(field: F, def?: Omit<ColumnDef<Row, F, Row[F]>, 'field' | 'key' | 'value'>): ColumnDef<Row>;
  computed<V>(id: string, value: (row: Row) => V, def?: Omit<ColumnDef<Row, string, V>, 'field' | 'key' | 'value'>): ColumnDef<Row>;
}

/**
 * Typed columns (values typed from the row type):
 *   const col = createColumnHelper<Customer>();
 *   const columns = [col.field('amount', { format: (v) => v.toFixed(2) }), col.computed('total', (r) => r.a + r.b)];
 */
export function createColumnHelper<Row>(): ColumnHelper<Row> {
  return {
    field: (field, def = {}) => ({ ...def, field }) as ColumnDef<Row>,
    computed: (field, value, def = {}) => ({ ...def, field, value }) as ColumnDef<Row>,
  };
}
