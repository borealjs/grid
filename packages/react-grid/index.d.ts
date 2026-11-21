// Type definitions for @borealjs/react-grid
import type { CSSProperties, ReactElement, ReactNode, Ref } from 'react';
import type {
  ArraySource,
  CellContext as CoreCellContext,
  ColumnDef as CoreColumnDef,
  CustomFilterApi,
  DataSource,
  Grid,
  GridOptions,
  HeaderContext,
} from '@borealjs/grid-core';

export { createArraySource, createHttpSource } from '@borealjs/grid-core';
export type {
  Grid,
  Grid as GridApi,
  DataSource,
  Query,
  SortItem,
  FilterItem,
  ColumnFilterItem,
  HeaderContext,
  CustomFilterApi,
  SelectionInfo,
  Selection,
  SelectionRange,
  CopyInfo,
  ViewChangeInfo,
  Layout,
  TableLayout,
  PivotLayout,
  CellRect,
  Messages,
} from '@borealjs/grid-core';

/** What renderCell / format / cellClass receive. `row` is the record for in-memory rows (undefined for servers). */
export interface CellContext<Row = any, V = unknown> extends Omit<CoreCellContext<V>, 'column'> {
  row: Row | undefined;
  column?: ColumnDef<Row>;
}

/** A custom filter rendered by React inside the grid's filter dialog; Apply sends { op, value }. */
export interface ReactCustomFilter {
  /** Operator the data source receives (for in-memory rows, a key of `filterFns`). Default 'custom'. */
  op?: string;
  render(api: CustomFilterApi): ReactNode;
}

/** The value type of a field: exact for a known field, `any` when the column is not tied to one. */
type FieldValue<Row, F> = string extends F ? any : F extends keyof Row ? Row[F] : any;

/**
 * A column. With in-memory `rows`, `field` names the property to show (or use `value(row)`).
 * Functions may be inline. Changing a field, title, type, width or filter redraws the whole grid.
 */
export interface ColumnDef<Row = any, F extends string = string, V = FieldValue<Row, F>>
  extends Omit<CoreColumnDef, 'key' | 'renderCell' | 'renderHeader' | 'filter' | 'format' | 'cellClass' | 'value' | 'compare'> {
  /** Field of the row (alias: `key`). Also the id used in sort / filter items and events. */
  field?: F;
  key?: F;
  format?(value: V, ctx: CellContext<Row, V> | null): string;
  cellClass?(value: V, ctx: CellContext<Row, V> | null): string | undefined | null | false;
  renderCell?(ctx: CellContext<Row, V>): ReactNode;
  renderHeader?(ctx: HeaderContext): ReactNode;
  filter?: Exclude<CoreColumnDef['filter'], { render: unknown }> | ReactCustomFilter;
  /** In-memory rows: computed value (default row[field]). */
  value?(row: Row): V;
  /** In-memory rows: sort comparator. */
  compare?(a: V, b: V): number;
}

/**
 * Typed columns (values typed from the row type):
 *   const col = createColumnHelper<Customer>();
 *   const columns = [col.field('amount', { format: (v) => v.toFixed(2) }), col.computed('total', (r) => r.a + r.b)];
 */
export function createColumnHelper<Row>(): {
  field<F extends Extract<keyof Row, string>>(field: F, def?: Omit<ColumnDef<Row, F, Row[F]>, 'field' | 'key' | 'value'>): ColumnDef<Row>;
  computed<V>(id: string, value: (row: Row) => V, def?: Omit<ColumnDef<Row, string, V>, 'field' | 'key' | 'value'>): ColumnDef<Row>;
};

export interface VirtualGridProps<Row = any>
  extends Omit<GridOptions, 'ariaLabel' | 'dataSource' | 'columns' | 'getColumn' | 'renderCell' | 'renderHeader' | 'renderEmpty' | 'format' | 'cellClass' | 'controlled'> {
  /** In-memory data (sorted, filtered and searched in the browser). New arrays update the grid in place. */
  rows?: readonly Row[];
  /** Or any data source (your backend: see useDataSource). */
  dataSource?: DataSource;
  columns?: ColumnDef<Row>[];
  /** Or declare columns as <Column> children. */
  children?: ReactNode;
  /** Very wide tables: describe column i (wrap in useCallback; a new function redraws the whole grid). */
  getColumn?(index: number): ColumnDef<Row>;
  /** In-memory rows: custom filter operators, { op: (cellValue, conditionValue, row) => boolean }. */
  filterFns?: Record<string, (value: any, conditionValue: any, row: Row) => boolean>;
  /** Grid-wide cell hooks (pivots and columns without their own). */
  format?(value: unknown, ctx: CellContext<Row> | null): string;
  cellClass?(value: unknown, ctx: CellContext<Row> | null): string | undefined | null | false;
  renderCell?(ctx: CellContext<Row>): ReactNode;
  renderHeader?(ctx: HeaderContext): ReactNode;
  /** Shown when there are no rows (`filtered`: because of a filter). */
  emptyState?: ReactNode | ((ctx: { filtered: boolean }) => ReactNode);
  /** Controlled selection (pair with onSelectionChange). */
  selectedCells?: { active?: { r: number; c: number }; ranges?: { r0: number; c0: number; r1: number; c1: number }[] };
  className?: string;
  style?: CSSProperties;
  id?: string;
  /** Accessible name of the grid, read by screen readers. */
  'aria-label'?: string;
  ref?: Ref<Grid>;
}

/**
 * The grid. Give it a size (CSS height, or a flex child with min-height: 0).
 * `sort` / `filter` / `columnFilter` / `selectedCells` are controlled when passed (update them from the
 * on…Change callbacks); use defaultSort etc. for uncontrolled state. The ref is the Grid API.
 */
export declare function VirtualGrid<Row = any>(props: VirtualGridProps<Row>): ReactElement | null;

/** Declares a column as JSX inside <VirtualGrid>; takes the same props as a column object. */
export declare function Column<Row = any, F extends Extract<keyof Row, string> | (string & {}) = string>(props: ColumnDef<Row, F>): null;

/**
 * A data source from callbacks that may close over props and state. Stays the same object; when `deps`
 * change the grid reloads what is visible (keeping scroll, sort and filter).
 */
export function useDataSource(spec: DataSource, deps?: readonly unknown[]): DataSource & { version: number };

/** An in-memory data source object that stays the same while rows and options do. */
export function useArraySource<Row = any>(
  rows: Row[],
  options?: {
    columns?: (ColumnDef<Row> | string | number)[];
    filterFns?: Record<string, (value: any, conditionValue: any, row: Row) => boolean>;
    compare?(a: unknown, b: unknown): number;
  },
): ArraySource<Row>;
