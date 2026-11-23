// @borealjs/react-grid — React bindings for @borealjs/grid-core.
//
//   <VirtualGrid data={rows} columns={columns} />                      in-memory rows
//   <VirtualGrid data={useDataSource({ getRows, … }, deps)} />          your backend
//   <VirtualGrid data={rows}><Column field="name" title="Name" /></VirtualGrid>

export { VirtualGrid } from './VirtualGrid.js';
export { Column, createColumnHelper, type ColumnHelper } from './columns.js';
export { useDataSource, type ReactDataSource } from './hooks.js';
export type { CellContext, CellEvent, ColumnDef, FieldValue, FilterFns, ReactCustomFilter, SelectedCells, VirtualGridProps } from './types.js';

export { createArraySource, createHttpSource } from '@borealjs/grid-core';
export type {
  Grid,
  DataSource,
  Query,
  QueryPart,
  AdvancedOptions,
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
  Progress,
  SortTarget,
  FilterTarget,
  Layout,
  TableLayout,
  PivotLayout,
  CellRect,
  Messages,
  ArraySource,
  RowId,
  RowSelection,
  RowCheck,
  ColumnDescription,
  GetColumnsRequest,
  GetRowsRequest,
  RowsResult,
} from '@borealjs/grid-core';
