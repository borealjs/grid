// @borealjs/react-grid — React bindings for @borealjs/grid-core.
//
//   <VirtualGrid rows={data} columns={columns} />                       in-memory rows
//   <VirtualGrid dataSource={useDataSource({ getCells, … }, deps)} />    your backend
//   <VirtualGrid rows={data}><Column field="name" title="Name" /></VirtualGrid>

export { VirtualGrid } from './VirtualGrid.js';
export { Column, createColumnHelper, type ColumnHelper } from './columns.js';
export { useDataSource, useArraySource, type ReactDataSource, type UseArraySourceOptions } from './hooks.js';
export type { CellContext, CellEvent, ColumnDef, FieldValue, FilterFns, ReactCustomFilter, SelectedCells, VirtualGridProps } from './types.js';

export { createArraySource, createHttpSource, createRowSource } from '@borealjs/grid-core';
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
  RowSource,
  RowSourceOptions,
} from '@borealjs/grid-core';
