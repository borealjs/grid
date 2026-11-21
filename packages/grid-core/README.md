# @borealjs/grid-core

A DOM data grid that stays fast at any size: billions of rows, millions of columns, rows of different
heights, multi-level headers and pivots. You give it **callbacks**; it decides what to load, caches it,
batches and cancels requests, and only touches the DOM nodes that changed.

- Server-side or in-memory data through one small `DataSource` interface
- Sorting (multi-column), filtering (ranges, value lists with search, text, custom), column filtering
- Pivot layouts: row/column trees with subtotals, expand/collapse, spanning group headers
- Merged cells, range selection, keyboard navigation (WAI-ARIA grid), copy as TSV + HTML
- Customizable: `format`, `cellClass`, `renderCell`, `renderHeader`, custom filter dialogs, messages, theme tokens
- No dependencies, plain ES modules, TypeScript types. React wrapper: [`@borealjs/react-grid`](../react-grid)


## Install

```bash
npm install @borealjs/grid-core
```

```js
import { createGrid, createArraySource } from '@borealjs/grid-core';
import '@borealjs/grid-core/style.css';
```

The grid fills its host element, so give the host a size (`height: 500px`, or a flex child with `min-height: 0`).

## Quick start (in-memory)

```js
const columns = [
  { key: 'id', title: 'ID', type: 'number' },
  { key: 'name', title: 'Name' },
  { key: 'status', title: 'Status', filter: 'values' },
  { key: 'amount', title: 'Amount', type: 'number', format: (v) => `$${v.toFixed(2)}` },
];
const grid = createGrid(document.getElementById('grid'), {
  dataSource: createArraySource(rows, { columns }),
  columns,
  onSortChange: (sort) => console.log(sort), // [{ column: 3, key: 'amount', direction: 'desc' }]
});
```

## Your own data source

Only `getCells` is required. Every call gets an `AbortSignal`; the grid aborts requests that scrolled out of view.

```js
const dataSource = {
  // Row count for the current filter (tables) or the row/column trees (pivots).
  async getLayout({ query, signal }) {
    const res = await fetch(`/api/count?${toParams(query)}`, { signal });
    return { rowCount: (await res.json()).count };
  },
  // One or more rectangles of cells. Return rows of values per rect ([[a, b], [c, d]]) or row-major arrays.
  async getCells({ rects, query, signal }) {
    const res = await fetch('/api/cells', { method: 'POST', body: JSON.stringify({ rects, query }), signal });
    return (await res.json()).cells;
  },
  // Optional: distinct values for 'values' filters. Send at most `limit` (1000); the dialog asks the user
  // to refine the search when `matches` is larger.
  async getFilterValues({ column, key, search, limit, signal }) { /* … */ },
  // Optional: header labels for axes too large to describe up front (pivot groups, untitled columns).
  async getLabels({ axis, level, start, count, query, signal }) { /* … */ },
  maxRectsPerRequest: 400, // 1 = one rect per call
  maxCellsPerRequest: 20000,
};
```

Rects are in **source coordinates**: row = position in the sorted/filtered result, column = column index
(for collapsed pivot groups, the grid asks for thin strips instead of whole blocks, all batched in one call).

### The query

```ts
query = {
  sort: [{ column: 3, key: 'amount', direction: 'desc' }],          // or { level } for pivot row dimensions
  filter: [
    { column: 3, key: 'amount', op: 'range', min: 0, max: 100 },      // numbers or 'YYYY-MM-DD'
    { column: 2, key: 'status', op: 'in', values: ['Open'] },         // also 'notin'
    { column: 1, key: 'name', op: 'contains', text: 'ada' },
    { column: 7, key: 'score', op: 'atLeast', value: 90 },           // custom filters: your op, any JSON value
  ],
  columnFilter: [{ level: 0, op: 'in', values: ['Amount'] }],       // which columns are shown
}
```

Mapping it to SQL is direct: `filter` → a parameterized `WHERE`, `sort` → `ORDER BY … , id`, a rect → rows
`row … row + rowCount - 1` of that order and the columns `col … col + colCount - 1` (map column indexes to an
allow-list of column names; never put client text into SQL). For deep positions in big tables, number the
rows of each sort/filter once (`row_number() OVER (…)`) or use a columnar engine instead of `OFFSET`.

### Bundled sources

- `createArraySource(rows, { columns, filterFns, compare })`: rows in memory (objects or arrays). Natural
  text order, empty values last, stable multi-column sort, value lists with search. `source.setRows(next)`
  then `grid.refresh()` when the data changes.
- `createHttpSource({ baseUrl, params, headers, fetch })`: the reference HTTP protocol implemented by
  `server.mjs` in the repository (useful as a template for your backend).

## Columns

```js
{
  key: 'amount',              // id used in queries/events, and the field name for the in-memory source
  title: 'Amount',
  type: 'number',             // aligns to the end, range filter ('date': date range)
  width: 120,
  filter: 'values',           // 'text' | 'number' | 'date' | 'values' | { type: 'values', values } | custom | false
  sortable: true, resizable: true, hidden: false,
  group: 'Money',             // for the column chooser (column filter level 0)
  format: (value, ctx) => '…',          // fast path: the cell stays a text node
  cellClass: (value, ctx) => 'negative',
  renderCell: (el, ctx) => { el.append(badge(ctx.value)); return () => el.replaceChildren(); },
  renderHeader: (el, ctx) => { el.textContent = ctx.label.toUpperCase(); },
}
```

For very wide tables pass `columnCount` and `getColumn(index)` instead of `columns`; titles you leave out
are loaded with `getLabels`.

`format`, `cellClass` and `renderCell` receive a context: `value`, `row` (the record, for in-memory
sources), `text`, `rowIndex` / `colIndex` (on screen), `rowSource` / `colSource` (in the data source),
`column` and `grid`. Links, buttons and inputs drawn by renderers get their own clicks and keys (mark other
interactive elements with `data-vg-interactive`). `renderEmpty(el, { filtered })` draws the empty state.

`format` and `cellClass` keep the hot path cheap. Renderers run only when a cell's content changes (never on
plain scrolling of an already filled cell), and may return a cleanup.

### Which filter a column gets

1. `filter` on the column decides: `'values'` (checkbox list), `'text'` (contains), `'number'` / `'date'`
   (range), a custom filter, or `false` (none).
2. Without `filter`, the column `type` decides: `'number'` → number range, `'date'` → date range, anything
   else → text search.
3. A `'values'` list comes from `filter.values` when you give it, otherwise from `dataSource.getFilterValues`
   (first 1,000 matches, searchable). If the data source has neither, the column falls back to text search.
4. Pivot dimensions use `getFilterValues` too (the reference server lists regions, countries, cities, years,
   quarters, months); products have too many names to list, so they are searched by text.

Use value lists for columns with a modest set of repeated values (status, city, owner) and text search for
near-unique ones (names, codes, IDs as text).

Filtering needs `getLayout` (the grid asks how many rows match). If your layout reports `maxFilterRows` /
`maxSortRows` and the table is bigger, the filter dialog says so up front and multi-column sorts are refused
with a notice, instead of sending requests the backend would reject.

### Custom filters

```js
filter: {
  op: 'atLeast',
  render(el, api) {           // api: value, setValue, apply, clear, close, column, title
    const input = Object.assign(document.createElement('input'), { type: 'range', value: api.value ?? 50 });
    input.oninput = () => api.setValue(Number(input.value)); // the dialog's Apply button sends it
    el.append(input);
  },
}
// in-memory: createArraySource(rows, { filterFns: { atLeast: (v, min) => v >= min } })
```

## Options

| Option | Default | |
|---|---|---|
| `sortable`, `multiSort`, `filterable`, `resizable`, `expandable`, `copy`, `keyboard` | `true` | feature switches |
| `selection` | `'multi'` | `'single'` or `'none'` |
| `rowHeight`, `headerHeight`, `columnWidth`, `minColumnWidth` | 28, 34, 132, 48 | |
| `rowHeader` | row numbers | `false`, or `{ width, title, label(row) }` |
| `theme` | `'auto'` | `'light'`, `'dark'`; or set `--vg-*` CSS variables |
| `messages` | English | every text in the grid, for translation |
| `sort`, `filter`, `columnFilter` | | initial query; with `controlled: { sort: true }` the grid only reports changes |
| `format`, `cellClass`, `rowClass`, `renderCell`, `renderHeader`, `renderEmpty` | | grid-wide hooks (pivots use these) |
| `onSortChange`, `onFilterChange`, `onColumnFilterChange`, `onSelectionChange`, `onCopy`, `onColumnResize`, `onError`, `onReady` | | events |

`grid.setOptions(partial)` changes options later: callbacks and hooks apply at once, query options are
applied like `setSort`, structural options rebuild the grid keeping scroll position and query.

## API

`grid.ready`, `setSort / setFilter / setColumnFilter / getQuery`, `toggleSort(column)`, `openFilter(column)`,
`refresh()`, `repaint()`, `scrollToCell(row, col)`, `getSelection / setSelection / selectAll / copySelection`,
`cellValue / cellText`, `setColumnWidth`, `setMerges`, pivots: `levels`, `showLevel(axis, level)`,
`expandAll(axis)`, `toggleGroup(...)`, and `destroy()`.

## Pivots

Return a `PivotLayout` from `getLayout` (`{ type: 'pivot', rows: TreeSpec, cols: TreeSpec }`, see the types)
and the grid draws grouped headers, subtotals and expand/collapse; cells are addressed by source index in the
fully expanded trees, so collapsing never refetches.

## Keyboard

Arrows / Shift+arrows / ⌘ or Ctrl+arrows, Home/End, PageUp/PageDown, Enter, Esc, ⌘/Ctrl+A, ⌘/Ctrl+C,
Alt+S (sort by the active column, Shift adds), Alt+F (filter it), Alt+Shift+arrows (collapse/expand).
