// Compile-only checks of the published type definitions (npm run typecheck).
// "expect-error" lines below must keep failing to compile.
import { createGrid, type DataSource } from '@borealjs/grid-core';
import { VirtualGrid, Column, useDataSource, type ColumnDef, type GridApi, type SortItem, type FilterItem } from '@borealjs/react-grid';
import { useRef, useState } from 'react';

type Customer = { id: number; name: string; status: 'Active' | 'Closed'; amount: number };

const columns: ColumnDef<Customer>[] = [
  { field: 'id', title: 'ID', type: 'number', format: (v) => `#${v}` },
  { field: 'name', renderCell: ({ value, row }) => <b title={row?.status}>{value}</b> },
  { field: 'amount', type: 'number', cellClass: (v) => (v < 0 ? 'neg' : '') },
  { field: 'status', filter: 'values' },
  { field: 'score', title: 'Score', value: (row) => row.amount * 2, filter: { op: 'atLeast', render: (api) => <input onChange={(e) => api.setValue(Number(e.target.value))} /> } },
];

export function Customers({ rows }: { rows: Customer[] }) {
  const grid = useRef<GridApi>(null);
  const [sort, setSort] = useState<SortItem[]>([{ key: 'amount', direction: 'desc' }]);
  const [filter, setFilter] = useState<FilterItem[]>([]);
  return (
    <>
      <VirtualGrid<Customer> ref={grid} rows={rows} columns={columns} sort={sort} onSortChange={setSort} filter={filter} onFilterChange={setFilter}
        filterFns={{ atLeast: (v, min) => v >= min }} emptyState={({ filtered }) => (filtered ? 'No match' : 'Empty')} style={{ height: 400 }} />
      <VirtualGrid rows={rows} selection="single" theme="dark">
        <Column<Customer> field="name" title="Name" renderCell={({ value }) => <i>{value}</i>} />
        <Column field="amount" type="number" />
      </VirtualGrid>
      <button onClick={() => grid.current?.scrollToCell(100)}>Go</button>
    </>
  );
}

export function Server({ search }: { search: string }) {
  const source = useDataSource({
    getLayout: async ({ query }) => ({ rowCount: search.length * 1000 + query.filter.length }),
    getCells: async ({ rects }) => rects.map((r) => Array.from({ length: r.rowCount }, () => Array(r.colCount).fill(search))),
  }, [search]);
  return <VirtualGrid dataSource={source} columnCount={100} getColumn={(i) => ({ title: `C${i}` })} />;
}
const ds: DataSource = { getCells: () => [] };
createGrid(document.body, { dataSource: ds, renderCell: (el, ctx) => { el.textContent = `${ctx.rowIndex}:${ctx.colIndex}:${String(ctx.row)}`; } });

import { createColumnHelper } from '@borealjs/react-grid';
const col = createColumnHelper<Customer>();
const typed: ColumnDef<Customer>[] = [
  col.field('amount', { type: 'number', format: (v) => v.toFixed(2), cellClass: (v) => (v < 0 ? 'neg' : '') }),
  col.field('status', { renderCell: ({ value }) => <span>{value === 'Active' ? 'on' : 'off'}</span> }),
  col.computed('label', (r) => `${r.name} (${r.id})`, { renderCell: ({ value }) => value.toUpperCase() }),
];
// @ts-expect-error: not a field of Customer
col.field('nope');
// @ts-expect-error: amount is a number
col.field('amount', { format: (v) => v.toUpperCase() });
export const typedCols = typed;

export function Readme({ customers }: { customers: Customer[] }) {
  const ref = useRef<GridApi>(null);
  return (
    <VirtualGrid<Customer> ref={ref} rows={customers} onSortChange={(sort) => console.log(sort.length)} messages={{ noRows: 'Keine Treffer', searchValues: (n) => `${n ?? ''} Werte` }}
      emptyState={({ filtered }) => (filtered ? <p>none</p> : null)} rowHeader={{ width: 60, title: '#' }} onColumnResize={({ key, width }) => console.log(key, width)}>
      <Column<Customer, 'amount'> field="amount" format={(v) => v.toFixed(2)} />
      {/* @ts-expect-error: amount is a number */}
      <Column<Customer, 'amount'> field="amount" format={(v) => v.toUpperCase()} />
    </VirtualGrid>
  );
}

// Accessible name: `aria-label` in React, `ariaLabel` in the core options.
export const Labelled = ({ customers }: { customers: Customer[] }) => <VirtualGrid rows={customers} aria-label="Customers" />;
createGrid(document.body, { dataSource: ds, ariaLabel: 'Customers' });

// sortable / filterable per column or level; progress from getLayout.
createGrid(document.body, {
  dataSource: { getCells: () => [], getLayout: ({ onProgress }) => { onProgress?.({ phase: 'Checking rows', done: 1, total: 2 }); return { rowCount: 2 }; } },
  sortable: (t) => t.axis === 'rows' || t.key !== 'notes',
  filterable: (t) => !('level' in t) || t.level < 2,
  onViewChange: (info) => console.log(info.progress?.done, info.cancelled),
}).cancel();
export const Rules = ({ customers }: { customers: Customer[] }) => <VirtualGrid rows={customers} sortable={(t) => t.axis === 'cols' && t.key !== 'name'} filterable={false} />;

// Generated declarations: typed stats, engine and in-memory sources.
import { createArraySource, GridEngine, VirtualGrid as LegacyEngine, type GridStats, type GridModel, type ColumnDef as CoreColumnDef } from '@borealjs/grid-core';
const g = createGrid(document.body, { dataSource: ds });
const s: GridStats | undefined = g.stats();
console.log(s?.cache.inflight, g.engine instanceof GridEngine, LegacyEngine === GridEngine, g.levels?.rows[0]?.collapsible);
const people = createArraySource([{ name: 'Ada', age: 36 }], { columns: [{ key: 'name' }, { key: 'age', value: (r) => r.age * 2 }] });
const first: { name: string; age: number } | undefined = people.rowAt(0, { sort: [], filter: [], columnFilter: [] });
console.log(first?.name);
// @ts-expect-error: rows are typed
people.setRows([{ nope: true }]);
const typedCore: CoreColumnDef<number, { n: number }> = { key: 'n', value: (row) => row.n, format: (v) => v.toFixed(1) };
export const model: GridModel | undefined = g.engine?.model;
export const coreCols = [typedCore];

// Rows by offset / limit, row ids, checkboxes, cell events, pinned and reorderable columns.
import { createRowSource, type RowSelection, type CellEvent } from '@borealjs/react-grid';
const rest = createGrid(document.body, {
  dataSource: { getRows: async ({ offset, limit, sort, filter, signal }) => ({ rows: [{ id: offset, n: limit + sort.length + filter.length, s: String(signal) }], total: 1 }) },
  columns: [{ key: 'id', pinned: true }, { key: 'n', reorderable: false }],
  getRowId: (row) => row.id,
  rowSelection: true,
  columnOrder: ['n', 'id'],
  onRowSelectionChange: (sel) => console.log(sel.checks.map((c) => ('id' in c ? c.id : `${c.from}-${c.to}`))),
  onColumnOrderChange: (order) => console.log(order.join()),
  onCellClick: ({ row, key, event }) => console.log(row, key, event.type),
  onCellContextMenu: (e) => e.event.preventDefault(),
});
rest.setRowSelection({ checks: [{ from: 0, to: 49_999_999, query: rest.getQuery(), checked: true }, { id: 7, checked: false }] });
const howMany: number | undefined = rest.checkedCount();
console.log(howMany);
// Very wide tables: pin leading columns and keep the order compact.
createGrid(document.body, { dataSource: ds, columnCount: 1_000_000, getColumn: (i) => ({ title: `C${i}` }), pinnedColumns: 2, columnOrder: [[0, 4], 9, [5, 8]] });
const checkedRows: RowSelection = rest.getRowSelection();
console.log(checkedRows, rest.getRow(0), rest.getColumnOrder());
rest.setColumnOrder(['id', 'n']);
// @ts-expect-error: a data source needs rows or cells to be useful, but getRows must return { rows, total }
createGrid(document.body, { dataSource: { getRows: async () => [] } });
// Columns described on demand by the data source (a million distinct columns).
const describedSource: DataSource = {
  getCells: () => [],
  getLayout: () => ({ rowCount: 10, columnCount: 1_000_000 }),
  getColumns: ({ start, count }) => Array.from({ length: count }, (_, i) => ({ title: `C${start + i}`, type: 'number' as const, width: 90, filter: 'number' as const, group: 'Numbers' })),
};
createGrid(document.body, { dataSource: describedSource, columnChooser: true, getColumn: () => ({ format: (v) => String(v) }) });
const explicit = createRowSource<{ id: number }>({ getRows: async () => ({ rows: [{ id: 1 }], total: 1 }), columns: ['id'], pageSize: 50 });
createGrid(document.body, { dataSource: explicit });
export function Orders() {
  const [checked, setChecked] = useState<RowSelection>({ checks: [] });
  const source = useDataSource({ getRows: async ({ offset }) => ({ rows: [{ id: offset, name: 'A', status: 'Active' as const, amount: 1 }], total: 1 }) });
  const open = (e: CellEvent<Customer>) => console.log(e.row?.name, e.key);
  return (
    <VirtualGrid<Customer>
      dataSource={source}
      getRowId={(row) => row.id}
      rowSelection
      selectedRows={checked}
      onRowSelectionChange={setChecked}
      onCellDoubleClick={open}
      onCellContextMenu={({ row, event }) => { event.preventDefault(); console.log(row?.amount); }}
    >
      <Column field="id" pinned />
      <Column field="name" reorderable={false} />
    </VirtualGrid>
  );
}
