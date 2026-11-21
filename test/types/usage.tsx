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
