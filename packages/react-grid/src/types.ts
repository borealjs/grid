import type { CSSProperties, ReactNode, Ref } from 'react';
import type {
  CellContext as CoreCellContext, ColumnDef as CoreColumnDef, CustomFilterApi, DataSource, EmptyContext, Grid, GridOptions, HeaderContext,
  SelectionRange,
} from '@borealjs/grid-core';

/** What renderCell / format / cellClass receive. `row` is the record for in-memory rows (undefined for servers). */
export interface CellContext<Row = any, V = unknown> extends Omit<CoreCellContext<V>, 'column' | 'row'> {
  readonly row: Row | undefined;
  column?: ColumnDef<Row>;
}

/** A custom filter rendered by React inside the grid's filter dialog; Apply sends { op, value }. */
export interface ReactCustomFilter {
  /** Operator the data source receives (for in-memory rows, a key of `filterFns`). Default 'custom'. */
  op?: string;
  render(api: CustomFilterApi): ReactNode;
}

/** The value type of a field: exact for a known field, `any` when the column is not tied to one. */
export type FieldValue<Row, F> = string extends F ? any : F extends keyof Row ? Row[F] : any;

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

/** In-memory rows: custom filter operators, { op: (cellValue, conditionValue, row) => boolean }. */
export type FilterFns<Row = any> = Record<string, (value: any, conditionValue: any, row: Row) => boolean>;

/** Controlled selection (pair with onSelectionChange). */
export interface SelectedCells {
  active?: { r: number; c: number };
  ranges?: SelectionRange[];
}

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
  filterFns?: FilterFns<Row>;
  /** Grid-wide cell hooks (pivots and columns without their own). */
  format?(value: unknown, ctx: CellContext<Row> | null): string;
  cellClass?(value: unknown, ctx: CellContext<Row> | null): string | undefined | null | false;
  renderCell?(ctx: CellContext<Row>): ReactNode;
  renderHeader?(ctx: HeaderContext): ReactNode;
  /** Shown when there are no rows (`filtered`: because of a filter). */
  emptyState?: ReactNode | ((ctx: EmptyContext) => ReactNode);
  selectedCells?: SelectedCells;
  className?: string;
  style?: CSSProperties;
  id?: string;
  /** Accessible name of the grid, read by screen readers. */
  'aria-label'?: string;
  ref?: Ref<Grid>;
}
