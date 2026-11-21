# @borealjs/react-grid

A React data grid that stays fast at any size: hand it an array, or connect a backend with a hook, and
scroll through millions of rows and thousands of columns (billions with a server). Cells, headers,
filters and the empty state are plain React components.

```jsx
<VirtualGrid rows={customers} style={{ height: 600 }}>
  <Column field="name" title="Customer" />
  <Column field="status" title="Status" filter="values" renderCell={({ value }) => <Badge status={value} />} />
  <Column field="amount" title="Amount" type="number" format={(v) => money.format(v)} />
</VirtualGrid>
```

- **Data your way**: `rows` for in-memory data (sorted, filtered and searched in the browser), or
  `useDataSource` for any backend (REST, GraphQL, SQL, a worker), with caching, batching and cancellation done for you
- **React all the way**: JSX columns, components in cells / headers / filters, your context providers apply,
  inline functions are fine (no memoizing needed)
- **Controlled or uncontrolled** sort, filter, column filter and selection
- Sorting (multi-column), filters (ranges, value lists with search, text, your own), column chooser,
  pivots with subtotals and expand/collapse, merged cells, range selection, keyboard navigation, copy
- TypeScript types inferred from your row type, SSR / Next.js ready (`'use client'`), no dependencies besides React


## Contents

[Install](#install) · [Quick start](#quick-start) · [Columns](#columns) · [Custom cells](#custom-cells) ·
[Data](#data) · [Server data](#server-data-usedatasource) · [Sorting & filtering](#sorting-and-filtering) ·
[Controlled state](#controlled-state) · [Custom filters](#custom-filters) · [Selection & copy](#selection-and-copy) ·
[Grid API (ref)](#grid-api-ref) · [Events](#events) · [Styling](#styling-and-theming) · [Empty state](#empty-state) ·
[Translations](#translations) · [TypeScript](#typescript) · [Next.js & SSR](#nextjs-and-ssr) · [Pivots](#pivots) ·
[Performance](#performance) · [Accessibility](#accessibility-and-keyboard) · [Recipes](#recipes) · [All props](#all-props) · [FAQ](#faq)

## Install

```bash
npm install @borealjs/react-grid @borealjs/grid-core
```

```js
import '@borealjs/grid-core/style.css'; // once, e.g. in your root layout
```

React 18 or 19.

## Quick start

```jsx
import { VirtualGrid, Column } from '@borealjs/react-grid';
import '@borealjs/grid-core/style.css';

export function Customers({ customers }) {
  return (
    <VirtualGrid rows={customers} style={{ height: 600 }} aria-label="Customers">
      <Column field="id" title="ID" type="number" width={80} />
      <Column field="name" title="Customer" width={220} />
      <Column field="status" title="Status" filter="values" />
      <Column field="amount" title="Amount" type="number" format={(v) => `$${v.toFixed(2)}`} />
      <Column field="signedAt" title="Signed" type="date" />
    </VirtualGrid>
  );
}
```

That grid already sorts (click a header; Shift+click adds a column), filters (the funnel in each header),
resizes columns, selects ranges, copies with ⌘C / Ctrl+C and is fully keyboard accessible.

**Give it a height.** The grid fills its container: set `style={{ height }}`, a CSS class, or make it a flex
child with `flex: 1; min-height: 0`.

## Columns

Columns can be JSX children or an array; both take the same props.

```jsx
const columns = [
  { field: 'name', title: 'Customer', width: 220 },
  { field: 'amount', title: 'Amount', type: 'number' },
];
<VirtualGrid rows={rows} columns={columns} />
```

| Prop | | |
|---|---|---|
| `field` | `string` | property of the row; also the column's id in sort / filter / events (alias: `key`) |
| `title` | `string` | header text |
| `type` | `'text' \| 'number' \| 'date'` | `number` aligns right and filters by range; `date` filters by date range |
| `width` | `number` | px (users can resize; see `onColumnResize`) |
| `align` | `'start' \| 'end' \| 'center'` | |
| `format` | `(value, ctx) => string` | text shown in the cell (fastest path) |
| `cellClass` | `(value, ctx) => string` | extra class per cell, e.g. negative numbers |
| `renderCell` | `(ctx) => ReactNode` | any React content |
| `renderHeader` | `(ctx) => ReactNode` | custom header content |
| `value` | `(row) => any` | computed column (in-memory rows) |
| `compare` | `(a, b) => number` | custom sort order (in-memory rows) |
| `filter` | `'text' \| 'number' \| 'date' \| 'values' \| { type: 'values', values } \| { op, render } \| false` | see [filters](#sorting-and-filtering) |
| `sortable`, `resizable`, `hidden` | `boolean` | |
| `group` | `string` | group name for the column chooser |
| `className`, `headerClass` | `string` | static classes |

**No memoizing needed.** Inline arrays and inline functions are fine: the grid rebuilds only when the
*structure* changes (fields, titles, types, widths, filters). New functions just redraw the visible cells,
so closures always see your latest state:

```jsx
const [highlight, setHighlight] = useState('');
<Column field="name" renderCell={({ value }) => <Highlight text={value} term={highlight} />} />
```

## Custom cells

`renderCell` gets a context object:

| | |
|---|---|
| `value` | the cell's value |
| `row` | the whole record (in-memory `rows`; `undefined` for server data) |
| `text` | the value after `format` |
| `rowIndex`, `colIndex` | position on screen (after sorting / filtering) |
| `rowSource`, `colSource` | position in the data source |
| `column` | the column definition |
| `grid` | the [Grid API](#grid-api-ref) |

```jsx
<Column field="status" renderCell={({ value }) => <span className={`badge badge-${value}`}>{value}</span>} />
<Column field="progress" type="number" renderCell={({ value }) => <ProgressBar value={value} />} />
<Column field="actions" title="" sortable={false} filter={false}
  renderCell={({ row }) => <button onClick={() => openCustomer(row.id)}>Open</button>} />
```

- Components in cells can use hooks and context (they render through portals inside your tree).
- Links, buttons and inputs in cells work as usual: clicks on them don't move the selection, and keys typed
  into an input stay in the input. Mark other interactive elements with `data-vg-interactive`.
- Keep cells light: they are mounted as rows scroll into view. Prefer `format` / `cellClass` for plain text.

Grid-wide `renderCell`, `format`, `cellClass` and `renderHeader` props apply to columns without their own
(and to pivots, which have no column definitions).

## Data

### In-memory: `rows`

```jsx
const [rows, setRows] = useState(initialRows);
<VirtualGrid rows={rows} columns={columns} />
```

Sorting (natural order: "Item 2" before "Item 10", empty values last), filtering and value lists run in the
browser; a million rows is fine. Passing a new array updates the grid in place: scroll position, sort,
filter and selection stay. Rows can be objects (`field` names a property) or arrays (columns map by position).

### Server data: `useDataSource`

Give the grid callbacks; it decides what to load, caches it, batches scattered requests, prioritizes what is
on screen and aborts what scrolled away (every call gets an `AbortSignal`).

```jsx
import { VirtualGrid, Column, useDataSource } from '@borealjs/react-grid';

function Orders({ customerId }) {
  const source = useDataSource({
    // How many rows match the current filter.
    async getLayout({ query, signal }) {
      const res = await fetch(`/api/orders/count?${params(customerId, query)}`, { signal });
      return { rowCount: (await res.json()).count };
    },
    // Rectangles of cells: rows row … row + rowCount - 1 of the sorted / filtered result,
    // columns col … col + colCount - 1. Return the rows of values for each rect.
    async getCells({ rects, query, signal }) {
      const res = await fetch('/api/orders/cells', {
        method: 'POST',
        body: JSON.stringify({ customerId, rects, query }),
        signal,
      });
      return (await res.json()).cells; // [ [[…row], [ …row]], … ] one entry per rect
    },
    // Optional: values for 'values' filters (first `limit` matching `search`).
    async getFilterValues({ key, search, limit, signal }) {
      const res = await fetch(`/api/orders/values?field=${key}&q=${encodeURIComponent(search)}&limit=${limit}`, { signal });
      return res.json(); // { values: string[], total, matches }
    },
  }, [customerId]); // when these change, the grid reloads in place

  return (
    <VirtualGrid dataSource={source} style={{ height: 600 }}>
      <Column field="id" title="Order" type="number" />
      <Column field="product" title="Product" filter="values" />
      <Column field="total" title="Total" type="number" />
    </VirtualGrid>
  );
}
```

The callbacks may use props and state freely; the source object stays the same, so the grid isn't rebuilt
when your component re-renders. Only `getCells` is required (without `getLayout`, pass `rowCount` and
filtering is off).

`query` looks like this (map it to SQL `WHERE` / `ORDER BY`, a search engine, …):

```js
{
  sort: [{ key: 'total', column: 2, direction: 'desc' }],
  filter: [
    { key: 'total', column: 2, op: 'range', min: 100, max: 500 },  // numbers or 'YYYY-MM-DD'
    { key: 'product', column: 1, op: 'in', values: ['Lamp'] },      // also 'notin'
    { key: 'note', column: 4, op: 'contains', text: 'urgent' },
    { key: 'score', column: 5, op: 'atLeast', value: 90 },          // custom filters
  ],
  columnFilter: [],
}
```

Use `key` (your field names) and keep an allow-list on the server; never put client text into SQL. For the
reference HTTP protocol there is a ready-made `createHttpSource({ baseUrl, params, headers })`.

## Sorting and filtering

Sorting is on by default: click a header (▲ ▼ off), Shift+click to add columns. `sortable={false}` turns it
off for the grid or a column; `multiSort={false}` allows one column only.

Each column gets a filter from its `filter` prop, else from its `type`:

| | dialog |
|---|---|
| `filter="values"` | checkbox list with search: values from `filter={{ type: 'values', values: [...] }}`, or from the data source (`rows`: distinct values; servers: `getFilterValues`). At most 1,000 are listed; the dialog asks to refine the search beyond that |
| `filter="text"` (default for text) | "contains" |
| `type="number"` / `filter="number"` | min / max |
| `type="date"` / `filter="date"` | from / to |
| `filter={{ op, render }}` | your component ([custom filters](#custom-filters)) |
| `filter={false}` | none |

Use value lists for columns with a modest set of repeated values (status, city, owner), text search for
near-unique ones (names, codes). If your server reports limits (`maxFilterRows` in `getLayout`), the dialog
explains why filtering is unavailable instead of failing.

## Controlled state

Pass a value to control it; leave it out (or pass `defaultSort` etc.) to let the grid keep it.

```jsx
const [sort, setSort] = useState([{ key: 'amount', direction: 'desc' }]);
const [filter, setFilter] = useState([]);

<VirtualGrid rows={rows} columns={columns}
  sort={sort} onSortChange={setSort}
  filter={filter} onFilterChange={setFilter} />

<button onClick={() => setFilter([])}>Clear filters</button>
```

| Value | Change event | Uncontrolled initial value |
|---|---|---|
| `sort` | `onSortChange` | `defaultSort` |
| `filter` | `onFilterChange` | `defaultFilter` |
| `columnFilter` | `onColumnFilterChange` | `defaultColumnFilter` |
| `selectedCells` | `onSelectionChange` | — |

Controlled values are compared by content, so passing a new array with the same items does nothing. Sort and
filter items can name columns by `key` (field) or `column` (index).

## Custom filters

A filter is a component; it gets `{ value, setValue, apply, clear, close, column, title, condition }`. The
dialog's Apply button sends the staged `value` as `{ op, value }` to the data source.

```jsx
function MinScore({ value, setValue }) {
  const [min, setMin] = useState(value ?? 50);
  useEffect(() => setValue(min), [min, setValue]);
  return <input type="range" min={0} max={100} value={min} onChange={(e) => setMin(+e.target.value)} />;
}

<VirtualGrid rows={rows} filterFns={{ atLeast: (cellValue, min) => cellValue >= min }}>
  <Column field="score" type="number" filter={{ op: 'atLeast', render: (api) => <MinScore {...api} /> }} />
</VirtualGrid>
```

With `rows`, `filterFns[op](cellValue, value, row)` decides; with a server, your backend receives
`{ key: 'score', op: 'atLeast', value: 72 }`.

## Selection and copy

Click, Shift+click, drag, ⌘/Ctrl+click to add ranges, ⌘/Ctrl+A. ⌘C / Ctrl+C copies as tab-separated text
(pastes into spreadsheets) plus an HTML table, loading any cells not on screen first.

```jsx
<VirtualGrid selection="single" onSelectionChange={(s) => setActive(s.active)} />  // 'multi' | 'single' | 'none'
<VirtualGrid copy={false} onCopy={(info) => toast(`Copied ${info.cells} cells`)} />
```

`onSelectionChange` receives `{ active: { r, c }, ranges, text, rows, cols, cells }`. Control it with
`selectedCells={{ active, ranges }}`.

## Grid API (ref)

```jsx
const grid = useRef(null);
<VirtualGrid ref={grid} … />

grid.current.scrollToCell(5000, 0);
```

| Method | |
|---|---|
| `scrollToCell(row, col)` | bring a cell into view |
| `refresh()` | reload what is visible (data changed on the server) |
| `setSort(sort)`, `setFilter(filter)`, `setColumnFilter(list)`, `getQuery()` | uncontrolled state from code |
| `toggleSort(field)`, `openFilter(field)`, `closeFilter()` | what the header buttons do |
| `getSelection()`, `setSelection(sel)`, `selectAll()`, `copySelection()`, `selectionInfo()` | |
| `cellValue(row, col)`, `cellText(row, col)` | loaded values |
| `setColumnWidth(col, px)`, `setMerges(list)` | |
| `rowCount`, `columnCount`, `visibleRange` | |
| `levels`, `showLevel(axis, level)`, `expandAll(axis)`, `toggleGroup(…)` | pivots |
| `focus()` | |

## Events

| Prop | Payload |
|---|---|
| `onSortChange` | `SortItem[]` |
| `onFilterChange` | `FilterItem[]` |
| `onColumnFilterChange` | `ColumnFilterItem[]` |
| `onSelectionChange` | `{ active, ranges, text, rows, cols, cells }` |
| `onCopy` | `{ ok, cells, rows, cols, fetched, ms, reason? }` |
| `onColumnResize` | `{ column, key, width }` (on release) |
| `onViewChange` | sort / filter progress: `{ pending }`, then `{ ok, rows, … }` or `{ ok: false, reason }` |
| `onError` | `(error, { kind: 'layout' \| 'cells' \| 'labels' })` (otherwise logged) |
| `onReady` | `(grid)` once drawn |

## Styling and theming

```jsx
<VirtualGrid className="my-grid" style={{ height: '70vh' }} theme="dark" />   // 'auto' (default) | 'light' | 'dark'
```

Everything is themed with CSS variables on `.vg`, so it fits any design system (or Tailwind via arbitrary
properties):

```css
.my-grid .vg {
  --vg-bg: #fff;  --vg-fg: #111827;  --vg-muted: #6b7280;  --vg-line: #e5e7eb;
  --vg-head: #f9fafb;  --vg-zebra: #fcfcfd;  --vg-accent: #7c3aed;  --vg-sel-fill: rgb(124 58 237 / 0.1);
  --vg-font: 14px/1.4 Inter, sans-serif;
}
```

`rowHeight`, `headerHeight`, `columnWidth`, `rowClass(rowIndex)`, `cellClass(value, ctx)` and per-column
`className` / `headerClass` cover the rest. The row-number column is `rowHeader={{ width, title, label }}` or
`rowHeader={false}`.

## Empty state

```jsx
<VirtualGrid rows={rows} emptyState={({ filtered }) => filtered
  ? <p>No matches. <button onClick={() => setFilter([])}>Clear filters</button></p>
  : <EmptyIllustration />} />
```

## Translations

Every text the grid shows is in `messages`:

```jsx
<VirtualGrid messages={{ noRows: 'Keine Treffer', apply: 'Anwenden', clear: 'Zurücksetzen',
  searchValues: (n) => `${n ?? ''} Werte durchsuchen`, refineSearch: (shown, total) => `${shown} von ${total} …` }} />
```

## TypeScript

Types come from your row type:

```tsx
type Customer = { id: number; name: string; amount: number; status: 'Active' | 'Closed' };

<VirtualGrid<Customer> rows={customers} onSortChange={(sort) => …}>
  <Column<Customer, 'amount'> field="amount" format={(v) => v.toFixed(2)} />   {/* v: number */}
</VirtualGrid>
```

For column arrays, `createColumnHelper` types each value exactly:

```tsx
import { createColumnHelper, type ColumnDef } from '@borealjs/react-grid';
const col = createColumnHelper<Customer>();

const columns: ColumnDef<Customer>[] = [
  col.field('name', { title: 'Customer' }),
  col.field('amount', { type: 'number', format: (v) => v.toFixed(2) }),          // v: number
  col.field('status', { renderCell: ({ value, row }) => <Badge s={value} /> }),  // value: 'Active' | 'Closed'
  col.computed('label', (r) => `${r.name} #${r.id}`, { title: 'Label' }),        // value: string
];
```

The ref is typed as `GridApi`: `useRef<GridApi>(null)`.

## Next.js and SSR

The package is marked `'use client'`, so you can render `<VirtualGrid>` from a Server Component page and pass
it serializable props (`rows`, column props without functions), or wrap it in your own client component when
you pass functions. Nothing touches the DOM until it mounts in the browser; server rendering outputs the
container only.

```tsx
// app/customers/page.tsx (Server Component)
import { CustomersGrid } from './customers-grid'; // 'use client' component with your renderCell etc.
export default async function Page() {
  return <CustomersGrid rows={await db.customers.findMany()} />;
}
```

## Pivots

Point the grid at a data source whose `getLayout` returns `{ type: 'pivot', rows, cols }` trees (see the core
docs) and it draws grouped headers, subtotals and expand/collapse; `ref.current.showLevel('rows', 1)` collapses
to a level. The reference server's pivot works out of the box:

```jsx
const pivot = useMemo(() => createHttpSource({ baseUrl: '/api', params: { mode: 'pivot' } }), []);
<VirtualGrid dataSource={pivot} onReady={(g) => setLevels(g.levels)} />
```

## Performance

- Only visible rows and columns exist in the DOM (plus a small margin); scrolling reuses the same elements.
- `format` / `cellClass` keep a cell a plain text node; `renderCell` mounts React content per visible cell.
  Both are fine for typical grids; for very dense grids prefer `format`.
- A cell renderer runs again only when the cell shows a different value, or when the functions you pass
  change (then the visible cells redraw).
- Changing a column's *structure* rebuilds the grid (scroll and query are kept). With `getColumn` (very wide
  tables), wrap the function in `useCallback`.
- Server data: return what is asked (rects), quickly; the grid caches about two million cells and keeps four
  sort/filter combinations.

## Accessibility and keyboard

The grid follows the WAI-ARIA grid pattern: one tab stop, `aria-rowcount` / `aria-colcount` for the whole
table, `aria-selected`, `aria-sort`, `aria-expanded`. Give it an `aria-label`.

| Keys | |
|---|---|
| Arrows, Home / End, PageUp / PageDown | move (⌘ / Ctrl jumps to the edge) |
| Shift + movement | extend the selection |
| Enter / Shift+Enter | next / previous cell (inside a selection: cycles through it) |
| ⌘/Ctrl+A, ⌘/Ctrl+C, Escape | select all, copy, reduce to one cell |
| Alt+S / Alt+Shift+S | sort by the active column / add it as another sort key |
| Alt+F | filter the active column |
| Alt+Shift+arrows | collapse / expand pivot groups |

## Recipes

**Debounced server search**

```jsx
const [search, setSearch] = useState('');
const debounced = useDeferredValue(search);        // or your own debounce hook
const source = useDataSource({ getLayout: …, getCells: … /* use debounced */ }, [debounced]);
```

**TanStack Query cache**

```jsx
const queryClient = useQueryClient();
const source = useDataSource({
  getCells: ({ rects, query, signal }) =>
    queryClient.fetchQuery({ queryKey: ['cells', rects, query], queryFn: () => api.cells(rects, query, signal), staleTime: 60_000 }),
  getLayout: ({ query, signal }) =>
    queryClient.fetchQuery({ queryKey: ['count', query], queryFn: () => api.count(query, signal) }),
});
```

**Refresh after a mutation**

```jsx
await api.updateOrder(id, patch);
grid.current.refresh();       // server data (or bump a useDataSource dependency)
setRows((rows) => [...rows]);  // in-memory rows
```

**Row actions with the row record**

```jsx
<Column field="actions" title="" width={120} sortable={false} filter={false}
  renderCell={({ row }) => <Menu onEdit={() => edit(row)} onDelete={() => remove(row.id)} />} />
```

## All props

Data: `rows`, `dataSource`, `columns` / `<Column>`, `columnCount` + `getColumn`, `rowCount`, `filterFns`, `layout`.
Look: `theme`, `className`, `style`, `rowHeight`, `headerHeight`, `columnWidth`, `minColumnWidth`, `rowHeader`,
`rowClass`, `messages`, `emptyState`, `notices`.
Features: `sortable`, `multiSort`, `filterable`, `resizable`, `expandable`, `selection`, `copy`, `keyboard`,
`columnChooser`, `columnGroups`.
State: `sort`, `filter`, `columnFilter`, `selectedCells`, `defaultSort`, `defaultFilter`, `defaultColumnFilter`.
Hooks: `format`, `cellClass`, `renderCell`, `renderHeader`.
Events: `onSortChange`, `onFilterChange`, `onColumnFilterChange`, `onSelectionChange`, `onCopy`, `onColumnResize`,
`onViewChange`, `onError`, `onReady`.
Other: `ref`, `id`, `aria-label`.

## FAQ

**Nothing shows up.** The grid needs a height (see [Quick start](#quick-start)).

**My column changes rebuild the grid.** Only structural changes do (field, title, type, width, filter kind).
Functions can change freely.

**Clicks on a button in a cell select the cell.** Links, buttons and form fields are excluded automatically;
add `data-vg-interactive` to other clickable elements.

**How do I show 10,000+ columns?** Use `columnCount` + `getColumn(index)` instead of an array; titles you leave
out can be loaded from the data source (`getLabels`).

**Can I edit cells?** Not built in yet; render an input in `renderCell` and save on change, then
`refresh()` / update `rows`.

**Does it work without React?** Yes: `@borealjs/grid-core` has the same features with a plain JS API.
