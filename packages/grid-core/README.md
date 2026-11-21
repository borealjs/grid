# @borealjs/grid-core

[![npm](https://img.shields.io/npm/v/@borealjs/grid-core)](https://www.npmjs.com/package/@borealjs/grid-core)
[![Bundle size](https://deno.bundlejs.com/badge?q=@borealjs/grid-core)](https://bundlejs.com/?q=@borealjs/grid-core)
[![Types](https://img.shields.io/npm/types/@borealjs/grid-core)](https://github.com/borealjs/grid/blob/main/packages/grid-core/src/types.ts)
[![License](https://img.shields.io/npm/l/@borealjs/grid-core)](https://github.com/borealjs/grid/blob/main/LICENSE)

A data grid for the web that stays smooth at any size: thousands to billions of rows and up to millions of
columns. Give it an array, or a few async callbacks that read from your backend. Works with plain JavaScript
and any framework; React users want [`@borealjs/react-grid`](https://www.npmjs.com/package/@borealjs/react-grid).

**[Live demo](https://borealjs.github.io/grid/)**: a billion-row table, a pivot and custom cells, right in your browser.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/borealjs/grid/main/media/grid-dark.png">
  <img alt="A pivot table with one billion rows, grouped headers and quarterly subtotals" src="https://raw.githubusercontent.com/borealjs/grid/main/media/grid-light.png">
</picture>

- Multi-column sorting; filters for ranges, dates, text, searchable value lists and your own
- Pivots with grouped headers, subtotals, expand and collapse
- Range selection, copy into spreadsheets, merged cells, full keyboard support
- Custom cells, headers, filters and empty state; CSS-variable themes, dark mode, translations
- About 40 kB gzipped, no dependencies, TypeScript types included

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Without a bundler](#without-a-bundler)
- [Columns and cells](#columns-and-cells): [pinned and reordered](#pinned-and-reordered-columns)
- [Sorting and filtering](#sorting-and-filtering)
- [Server data](#server-data): [cells, any size](#cells-any-size), [rows by offset / limit](#rows-by-offset--limit), [rows by id](#rows-by-id)
- [Selection and copy](#selection-and-copy), [checkboxes](#row-checkboxes), [cell events](#cell-events)
- [Controlled state](#controlled-state)
- [Styling and theming](#styling-and-theming)
- [Translations](#translations)
- [Pivots](#pivots)
- [Keyboard](#keyboard)
- [API reference](#api-reference)
- [FAQ](#faq)

## Installation

```bash
npm install @borealjs/grid-core
# or
pnpm add @borealjs/grid-core
yarn add @borealjs/grid-core
bun add @borealjs/grid-core
```

Import the styles once in your app:

```js
import '@borealjs/grid-core/style.css';
```

The package is published as ES modules and runs in all current browsers (Chrome, Edge, Firefox, Safari).

## Quick start

**1. Add a container with a height.** The grid fills it.

```html
<div id="grid" style="height: 500px"></div>
```

**2. Describe your columns and create the grid.**

```js
import { createGrid, createArraySource } from '@borealjs/grid-core';
import '@borealjs/grid-core/style.css';

const rows = [
  { id: 1, name: 'Ada Lovelace', status: 'Active', amount: 1200, signed: '2024-03-01' },
  { id: 2, name: 'Grace Hopper', status: 'Pending', amount: 950, signed: '2024-05-17' },
  { id: 3, name: 'Alan Turing', status: 'Active', amount: 1430, signed: '2023-11-30' },
];

const columns = [
  { key: 'id', title: 'ID', type: 'number', width: 80 },
  { key: 'name', title: 'Customer', width: 200 },
  { key: 'status', title: 'Status', filter: 'values' },
  { key: 'amount', title: 'Amount', type: 'number', format: (v) => `$${v.toFixed(2)}` },
  { key: 'signed', title: 'Signed', type: 'date' },
];

const grid = createGrid(document.getElementById('grid'), {
  dataSource: createArraySource(rows, { columns }),
  columns,
  ariaLabel: 'Customers',
  onSortChange: (sort) => console.log(sort), // [{ column: 3, key: 'amount', direction: 'desc' }]
});
```

That grid already sorts (click a header; Shift+click adds a column), filters (the funnel in each header),
resizes columns, selects ranges, copies with ⌘C / Ctrl+C and works from the keyboard.

> **Important**
> The grid takes the size of its container. If nothing shows up, give the container a height, or make it a
> flex child with `flex: 1; min-height: 0`.

## Without a bundler

Load the module and the stylesheet straight from a CDN:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@borealjs/grid-core@0.1.1/src/grid.css" />
<div id="grid" style="height: 400px"></div>

<script type="module">
  import { createGrid, createArraySource } from 'https://cdn.jsdelivr.net/npm/@borealjs/grid-core@0.1.1/+esm';

  const columns = [{ key: 'name', title: 'Name' }, { key: 'city', title: 'City', filter: 'values' }];
  const rows = [{ name: 'Ada', city: 'London' }, { name: 'Grace', city: 'New York' }];
  createGrid(document.getElementById('grid'), { dataSource: createArraySource(rows, { columns }), columns });
</script>
```

Pin the version in the URL so an update never changes your page unexpectedly.

## Columns and cells

```js
{
  key: 'amount',             // the row field, and the column's id in sort, filter and events
  title: 'Amount',
  type: 'number',            // 'number' aligns right and filters by range; 'date' filters by date range
  width: 120,
  format: (value) => money.format(value),
  cellClass: (value) => (value < 0 ? 'negative' : ''),
}
```

There are three ways to customize a cell, from lightest to most flexible:

| | Use it for |
|---|---|
| `format(value, ctx)` | the text shown: currencies, dates, units |
| `cellClass(value, ctx)` | a CSS class: colors, weights, icons from CSS |
| `renderCell(el, ctx)` | your own elements: badges, links, buttons, progress bars |

```js
renderCell(el, { value, row }) {
  const link = document.createElement('a');
  link.href = `/customers/${row.id}`;
  link.textContent = value;
  el.append(link);
}
```

`renderCell` draws into `el`. If it returns a function, that function runs before the cell shows something
else, so you can clean up (unmount a component, remove a listener). Links, buttons and inputs inside cells
work as usual; mark other clickable elements with `data-vg-interactive`.

All three receive the same context:

| | |
|---|---|
| `value` | the cell's value |
| `row` | the whole record (in-memory rows and `getRows` sources; `undefined` with `getCells`) |
| `text` | the value after `format` |
| `rowIndex`, `colIndex` | position on screen, after sorting and filtering |
| `rowSource`, `colSource` | position in the data source |
| `column` | the column definition |
| `grid` | the [grid API](#grid-methods) |

`renderHeader(el, ctx)` customizes a header the same way, and the `renderEmpty(el, { filtered })` option draws
the empty state. Options with the same names on the grid apply to every column that has none of its own.

### Very wide tables

For thousands or millions of columns, don't list them. Give the column count and let the data source describe
columns as they come into view with `getColumns`:

```js
const dataSource = {
  getCells, getLayout,                                    // getLayout returns { rowCount, columnCount }
  async getColumns({ start, count, query, signal }) {     // columns start … start + count - 1
    const res = await fetch(`/api/columns?from=${start}&n=${count}`, { signal });
    return res.json(); // [{ key, title, type: 'number', filter: 'number', width: 90, group: 'Amount' }, …]
  },
};
createGrid(el, { dataSource, columnChooser: true });
```

Each column keeps its title, type, alignment, filter, width and group, and only the columns on screen are
described: a million distinct columns never travel up front. A header shows a placeholder until its
description arrives; widths apply when they arrive. Functions (`format`, `renderCell`, …) come from
`getColumn(index)` in code, which wins over the description. With `getColumns` the column chooser asks the
data source too: groups through `getFilterValues({ axis: 'cols', level: 0 })`, and the chosen groups as the
query's `columnFilter`, after which the data source numbers the kept columns 0, 1, 2, … (sorts and filters on
columns start over). `createHttpSource` does all of this with a server that sends `columns: true` in `meta`.

Without `getColumns`, `getColumn(index)` describes columns in code, and the data source's `getLabels` can load
titles you leave out.

### Pinned and reordered columns

`pinned: true` keeps a column at the start while the rest scroll sideways. Users can drag column headers to
another place (Escape cancels); pinned columns stay together at the start.

```js
createGrid(el, {
  dataSource,
  columns: [{ key: 'id', pinned: true }, { key: 'name', pinned: true }, { key: 'amount' }, { key: 'actions', reorderable: false }],
  columnOrder: saved,                                   // keys in display order
  onColumnOrderChange: (order) => localStorage.setItem('order', JSON.stringify(order)),
});
```

`reorderable: false` on the grid turns dragging off; `grid.setColumnOrder(keys)` reorders from code.

Tables with millions of columns (`getColumns` or `getColumn`) work the same: `pinnedColumns: 2` pins the first two, and the
order is kept compactly as single indexes and `[first, last]` runs, e.g. `[[0, 4], 9, [5, 8], [10, 999999]]`, so
moving a column costs a few entries whatever the width.

## Sorting and filtering

Click a header to sort (▲, ▼, off); Shift+click adds it to the sort. Each column gets a filter dialog, chosen
like this:

1. The column's `filter` decides when it is set:

   | `filter` | Dialog |
   |---|---|
   | `'values'` | checkbox list with search |
   | `{ type: 'values', values: [...] }` | checkbox list of the values you give |
   | `'text'` | "contains" |
   | `'number'`, `'date'` | min and max, from and to |
   | `{ op, render }` | your own ([custom filters](#custom-filters)) |
   | `false` | no filter |

2. Otherwise the column's `type` decides: `'number'` gets a number range, `'date'` a date range, anything else
   a text search.
3. A value list shows the values you pass, or asks the data source (`getFilterValues`). At most 1,000 are
   listed; beyond that the dialog asks the user to refine the search. A data source without
   `getFilterValues` gets a text search instead.

Value lists suit columns with a modest set of repeated values (status, city, owner); text search suits
near-unique ones (names, codes).

### Choosing what can be sorted and filtered

`sortable: false` and `filterable: false` turn sorting or filtering off for the whole grid, and the same on a
column (`sortable: false`, `filter: false`) turns it off for that column. To decide in one place, or for pivot
levels, which have no column definitions, pass a function. It is asked about each column and level and
returns `false` to turn that one off:

```js
createGrid(el, {
  dataSource,
  columns,
  // Columns: { axis: 'cols', column, key }. Pivot row levels: { axis: 'rows', level }.
  sortable: (target) => target.key !== 'notes',
  // Filters also cover pivot column levels and the column chooser: { axis: 'cols', level }.
  filterable: (target) => target.axis !== 'rows' || target.level < 2,
});
```

### Custom filters

```js
{
  key: 'score',
  type: 'number',
  filter: {
    op: 'atLeast',
    render(el, api) {
      const input = Object.assign(document.createElement('input'), { type: 'range', value: api.value ?? 50 });
      input.oninput = () => api.setValue(Number(input.value)); // the dialog's Apply button sends it
      el.append(input);
    },
  },
}

// With in-memory rows, say what the operator means:
createArraySource(rows, { columns, filterFns: { atLeast: (cellValue, min) => cellValue >= min } });
```

`api` has `value`, `setValue(value)`, `apply(value?)`, `clear()`, `close()`, `column` and `title`. A server
receives `{ key: 'score', op: 'atLeast', value: 72 }` in the query's filter list.

## Server data

The grid never holds the whole table. It asks the data source only for what is on screen, and sorting,
filtering and finding rows are the data source's job, so everything works the same for a thousand rows or a
billion. Every call gets an `AbortSignal`: pass it to `fetch` so requests the grid no longer needs are
cancelled.

There are two shapes of data source:

| | Use it for | Asks for |
|---|---|---|
| [`getCells`](#cells-any-size) | any size: billions of rows, millions of columns, pivots | rectangles of cells by position |
| [`getRows`](#rows-by-offset--limit) | the quickest start with an ordinary REST, GraphQL or SQL endpoint | pages of row objects by offset / limit |

### Cells: any size

```js
const dataSource = {
  async getLayout({ query, signal }) {                    // how many rows match the current filter
    const res = await fetch(`/api/orders/count?q=${encodeURIComponent(JSON.stringify(query))}`, { signal });
    return { rowCount: (await res.json()).count };
  },
  async getCells({ rects, query, signal }) {              // the cells of one or more rectangles
    const res = await fetch('/api/orders/cells', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rects, query }), signal,
    });
    return (await res.json()).cells; // one entry per rect: [[a, b], [c, d]]
  },
};

createGrid(el, { dataSource, columns });
```

A rect is `{ row, col, rowCount, colCount }`: rows are positions in the sorted and filtered result, columns are
column indexes. Answer each rect with its rows of values (`[[a, b], [c, d]]`) or one flat row-major array. The
query names columns by `key` (and index):

```js
sort: [{ key: 'amount', column: 3, direction: 'desc' }],
filter: [
  { key: 'amount', column: 3, op: 'range', min: 0, max: 100 },   // numbers, or dates as 'YYYY-MM-DD'
  { key: 'status', column: 2, op: 'in', values: ['Open'] },      // also 'notin'
  { key: 'name', column: 1, op: 'contains', text: 'ada' },
  { key: 'score', column: 7, op: 'atLeast', value: 90 },         // custom filters
],
```

The server decides how to serve a position cheaply: an index on the sort column, a precomputed order, a
cursor. `createHttpSource` speaks a [ready-made HTTP API](#ready-made-sources) for this, and the repository's
reference server (`demo-backend.mjs`) serves a billion rows with it.

### Rows by offset / limit

The quickest way in when your API already pages rows. The grid reads each cell from the row by its column
`key` (or `value(row)`), and cells and events get the whole row.

```js
const dataSource = {
  // Rows offset … offset + limit - 1 of the sorted, filtered result, and how many rows match.
  async getRows({ offset, limit, sort, filter, signal }) {
    const params = new URLSearchParams({ offset, limit, sort: JSON.stringify(sort), filter: JSON.stringify(filter) });
    const res = await fetch(`/api/orders?${params}`, { signal });
    return res.json(); // { rows: [{ id: 1, product: 'Lamp', total: 120 }, …], total: 48213 }
  },
};

createGrid(el, { dataSource, columns, getRowId: (row) => row.id });
```

`limit` is the page size (100). With SQL, `filter` becomes a parameterized `WHERE`, `sort` an `ORDER BY` (add a
unique column last so the order is stable) and `offset` / `limit` become `OFFSET` / `LIMIT`. Map `key` to
column names through an allow-list on the server; never put client text into SQL.

Know where it stops: most databases walk past every skipped row for `OFFSET`, so pages deep into a huge table
get slow, and a row object has to carry every column, which does not work for thousands of columns. For those,
use `getCells`. `createRowSource({ getRows, columns, pageSize })` makes the same data source explicitly.

### Rows by id

With an id for each row the grid keeps track of rows, not positions. After a sort, a filter or `refresh()` the
selection stays on its row; checked rows from another sort or filter are shown where they are now.

- Ids come from `getRowId(row)` (in-memory rows default to the row itself), or from the data source's
  `rowIdAt(position, query)` for `getCells` sources whose server sends ids (`createHttpSource` does).
- The data source finds a row with `indexOfRow(id, query)`: its position, `-1` when it is not in that view, or
  `null` when it cannot tell. The in-memory source and `createHttpSource` (the `/find` request) do it at any
  size; `getRows` sources find rows among the pages they loaded, or ask your `indexOfRow`.
- When the selected row is gone, or the source cannot tell where it went, the selection moves to the first row
  and a notice says so (`messages.selectionRowGone`, `messages.selectionNotFollowed`); `onSelectionChange`
  reports `moved: 'rowGone' | 'notFollowed'`. Without row ids, a sort or filter moves the selection to the
  first row the same way, while a refresh keeps its position.

### Slow sorts and filters

Sorting or filtering a huge table can take a while. When it takes more than a moment, the grid shows what it
is doing with a Cancel button (in the filter dialog, or in a notice for sorts). The request that applies it
(`getRows` for the first page, or `getLayout`) receives an `onProgress` callback to say how far it is;
cancelling aborts its `signal`, so pass that on to `fetch` or your database query:

```js
async getRows({ offset, limit, sort, filter, signal, onProgress }) {
  const job = await startQuery({ sort, filter }, { signal });
  while (!job.done) {
    onProgress?.({ phase: 'Checking rows', done: job.checked, total: job.rows }); // "Filtering… Checking rows · 42% · 7 s"
    await job.next();
  }
  return job.page(offset, limit); // { rows, total }
}
```

`grid.cancel()` stops it from code, and `onViewChange` reports `{ pending: true, progress }` along the way and
`{ cancelled: true }` if it is stopped.

If your backend can't sort or filter very large tables at all, return `maxSortRows` / `maxFilterRows` from
`getLayout` (with `getCells`). The grid then explains the limit to the user instead of sending requests that would fail.

### Ready-made sources

- **`createArraySource(rows, options)`** sorts, filters and searches rows in memory (objects, or arrays
  addressed by position). Text sorts naturally ("Item 2" before "Item 10") and empty values go last. After
  `source.setRows(newRows)`, call `grid.refresh()`.
- **`createRowSource({ getRows, columns, pageSize, indexOfRow })`** loads rows by offset / limit (see
  [rows by offset / limit](#rows-by-offset--limit)).
- **`createHttpSource({ baseUrl, params, headers, fetch })`** talks to a server that implements this HTTP
  API. `params` are added to every request. The query is sent as `sort` (for example `3:d,L1:a`: a column
  index, or `L` and a pivot row level, then `a` or `d`) and as `filter` / `colfilter` (JSON lists of
  `{ c | dim, op, v | min | max }`).

  | Request | Response |
  |---|---|
  | `GET {baseUrl}/meta` | `{ rows, totalRows, cols }` for a table, or `{ mode: 'pivot', rows, cols, rowMaps?, colMaps? }` |
  | `GET {baseUrl}/block?r0&c0&nr&nc` | `{ cells, rowIds? }`, row-major; `rowIds`: the id of each row |
  | `POST {baseUrl}/gather` with `{ rects: [[r0, c0, nr, nc], …] }` | `{ cells: [one row-major array per rect], rowIds?: [one array per rect] }` |
  | `GET {baseUrl}/find?ids` with the same query (optional) | `{ positions }`: where those rows are, `-1` when filtered out |
  | `GET {baseUrl}/columns?from&n&colfilter` (when `meta` has `columns: true`) | `{ columns }`: column descriptions |
  | `GET {baseUrl}/values?axis=cols&level=0&q&limit` | column groups, for the column chooser |
  | `GET {baseUrl}/labels?axis&level&from&n` | `{ names }` |
  | `GET {baseUrl}/values?axis&level&q&limit` | `{ values, total, matches }` |
  | `GET {baseUrl}/progress` with the same query as `meta` (optional) | `{ active, phase, done, total }` while `meta` works |

## Selection and copy

Click, Shift+click, drag, ⌘/Ctrl+click to add ranges, ⌘/Ctrl+A to select all. ⌘C / Ctrl+C copies the
selection as tab-separated text (it pastes into Excel and Google Sheets) and as an HTML table, loading cells
that are not on screen first.

```js
createGrid(el, {
  dataSource,
  columns,
  selection: 'single', // 'multi' (default) | 'single' | 'none'
  onSelectionChange: (info) => console.log(info.active, info.cells),
  onCopy: (info) => console.log(`Copied ${info.cells} cells`),
});
```

### Row checkboxes

`rowSelection: true` adds a checkbox to each row number; the one in the corner checks every row. Shift+click
checks a range, and Space checks the active row.

```js
const grid = createGrid(el, {
  dataSource, columns, getRowId: (row) => row.id,
  rowSelection: true,
  onRowSelectionChange: (sel) => console.log(sel.checks, grid.checkedCount()),
});
```

Checked rows are a list of steps in the order they were made; the last step covering a row decides:

```js
{ checks: [
  { from: 0, to: 49_999_999, query, checked: true },   // Shift+click: rows 1 to 50,000,000 of that sort / filter
  { id: 812, checked: false },                         // then one row unchecked
] }
```

A range costs the same for 10 rows or 50 million and needs no rows loaded, so checking works the same at any
size, and memory grows with clicks, not rows. The corner checkbox is one range over the view. Your server can
act on the same steps (positions under the query, plus ids) to delete or export what is checked.
`grid.checkedCount()` counts them when it can without the server. Rows checked in another sort or filter are
placed through `indexOfRow`; when that is not possible a notice says so (`messages.checksNotShown`) and they stay
checked.

### Cell events

```js
createGrid(el, {
  dataSource, columns,
  onCellClick: ({ row, key, value }) => showDetail(row),
  onCellDoubleClick: ({ row }) => openEditor(row),
  onCellContextMenu: ({ row, event }) => {
    event.preventDefault();              // instead of the browser's menu
    showMenu(event.clientX, event.clientY, row);
  },
});
```

Each event gets the cell's context (`row`, `value`, `text`, `rowIndex`, `column`, …), its `key` and the DOM
`event`. A right click outside the selection selects the cell first, and the context-menu key (or Shift+F10)
opens the menu for the active cell. Clicks on links, buttons and inputs in cells are theirs, not cell clicks.

## Controlled state

By default the grid keeps its own sort and filters. To own them yourself (to store them in the URL, say),
mark them controlled. The grid then only reports what the user asked for, and you apply it:

```js
const grid = createGrid(el, {
  dataSource,
  columns,
  sort: [{ key: 'amount', direction: 'desc' }],
  controlled: { sort: true },
  onSortChange(sort) {
    saveToUrl(sort);
    grid.setSort(sort);
  },
});
```

Sort and filter items may name a column by `key` or by `column` index.

## Styling and theming

`theme: 'auto'` (the default) follows the system's light or dark mode; `'light'` and `'dark'` force one. Colors,
fonts and lines are CSS variables, so the grid fits any design system:

```css
#grid .vg {
  --vg-bg: #ffffff;
  --vg-fg: #111827;
  --vg-muted: #6b7280;
  --vg-line: #e5e7eb;
  --vg-head: #f9fafb;
  --vg-zebra: #fcfcfd;
  --vg-accent: #7c3aed;
  --vg-sel-fill: rgb(124 58 237 / 0.1);
  --vg-font: 14px/1.4 Inter, sans-serif;
}
```

Sizes are options (`rowHeight`, `headerHeight`, `columnWidth`), and `rowClass`, `cellClass`, `className` and
`headerClass` add your own classes.

## Translations

Every text the grid shows is in `messages`. Pass the ones you want to change:

```js
createGrid(el, {
  dataSource,
  columns,
  messages: {
    noRows: 'Keine Zeilen',
    apply: 'Anwenden',
    clear: 'Zurücksetzen',
    searchValues: (n) => `${n ?? ''} Werte durchsuchen`,
  },
});
```

`DEFAULT_MESSAGES` has the full list with the English texts.

## Pivots

Return a pivot layout from `getLayout` and the grid draws grouped row and column headers, subtotals and
expand/collapse:

```js
async getLayout() {
  return {
    type: 'pivot',
    rows: { levels: [{ name: 'Region' }, { name: 'Country' }], leafName: 'Product', leafSize: 28, roots: 4, fanout: [[3, 2, 4, 1], [/* … */]] },
    cols: { levels: [{ name: 'Year' }], leafName: 'Month', leafSize: 96, roots: 10, fanout: [[12, 12, /* … */]] },
  };
}
```

In `getCells`, rows and columns are positions in the fully expanded trees, so they stay the same when groups
collapse. `grid.showLevel('rows', 0)` collapses to a level and `grid.expandAll('rows')` opens everything again.
See the `TreeSpec` type for all fields.

## Keyboard

The grid is one tab stop and follows the WAI-ARIA grid pattern. Give it an accessible name with the
`ariaLabel` option. <kbd>Ctrl</kbd> is <kbd>⌘</kbd> on macOS.

| Keys | Action |
|---|---|
| <kbd>←</kbd> <kbd>→</kbd> <kbd>↑</kbd> <kbd>↓</kbd> | Move to the next cell |
| <kbd>Ctrl</kbd>+arrow | Jump to the first or last row or column |
| <kbd>Home</kbd> / <kbd>End</kbd> | First or last cell of the row |
| <kbd>Ctrl</kbd>+<kbd>Home</kbd> / <kbd>Ctrl</kbd>+<kbd>End</kbd> | First or last cell of the grid |
| <kbd>Page Up</kbd> / <kbd>Page Down</kbd> | Move by one screen |
| <kbd>Shift</kbd>+any of the above | Extend the selection |
| <kbd>Enter</kbd> / <kbd>Shift</kbd>+<kbd>Enter</kbd> | Next or previous cell; inside a selection, cycle through it |
| <kbd>Ctrl</kbd>+<kbd>A</kbd> | Select all |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Copy the selection |
| <kbd>Escape</kbd> | Reduce the selection to the active cell |
| <kbd>Alt</kbd>+<kbd>S</kbd> | Sort by the active column (<kbd>Shift</kbd> adds it to the sort) |
| <kbd>Alt</kbd>+<kbd>F</kbd> | Open the active column's filter |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+arrow | Collapse or expand a pivot group |

## API reference

### `createGrid(host, options)`

Creates a grid inside `host` and returns its [API](#grid-methods).

#### Data

| Option | Type | Default | |
|---|---|---|---|
| `dataSource` | `DataSource` | required | where the data comes from ([server data](#server-data), [ready-made sources](#ready-made-sources)) |
| `getRowId` | `(row) => string \| number` | in-memory: the row itself | stable row ids ([rows by id](#rows-by-id)) |
| `columns` | `ColumnDef[]` | | the columns ([column options](#column-options)) |
| `columnCount`, `getColumn` | `number`, `(index) => ColumnDef` | | instead of `columns`, for thousands of columns ([very wide tables](#very-wide-tables)) |
| `rowCount` | `number` | | row count when the data source has no `getLayout` (filtering is then off) |
| `layout` | `Layout` | | a layout you already have, to skip the first `getLayout` call |

#### Features

| Option | Type | Default | |
|---|---|---|---|
| `sortable` | `boolean \| (target) => boolean` | `true` | sorting from headers and the keyboard; a function decides per column or level ([choosing](#choosing-what-can-be-sorted-and-filtered)) |
| `multiSort` | `boolean` | `true` | Shift+click adds columns to the sort |
| `filterable` | `boolean \| (target) => boolean` | `true` | filter buttons in headers; a function decides per column or level |
| `resizable` | `boolean` | `true` | drag header edges to resize columns |
| `expandable` | `boolean` | `true` | expand and collapse pivot groups |
| `selection` | `'multi' \| 'single' \| 'none'` | `'multi'` | |
| `copy` | `boolean` | `true` | ⌘C / Ctrl+C copies the selection |
| `keyboard` | `boolean` | `true` | keyboard navigation |
| `notices` | `boolean` | `true` | short messages in the grid: copies, and slow, refused or failed sorts and filters; turn it off to show `onCopy` / `onViewChange` yourself |
| `columnChooser` | `boolean` | on when columns have a `group` | a corner menu to show and hide column groups |
| `rowSelection` | `boolean` | `false` | [row checkboxes](#row-checkboxes) |
| `reorderable` | `boolean` | `true` | drag column headers to reorder |

#### Look

| Option | Type | Default | |
|---|---|---|---|
| `theme` | `'auto' \| 'light' \| 'dark'` | `'auto'` | |
| `ariaLabel` | `string` | | the grid's name for screen readers |
| `rowHeight` | `number` | `28` | px |
| `headerHeight` | `number` | `34` | px |
| `columnWidth` | `number` | `132` | px, for columns without `width` |
| `minColumnWidth` | `number` | `48` | px, the smallest a user can resize to |
| `rowHeader` | `false \| { width, title, label(row) }` | row numbers, 72 px | the row-number column |
| `rowHeaderWidths` | `number[]` | | widths of the pivot row-header columns |
| `messages` | `Partial<Messages>` | English | [translations](#translations) |
| `format`, `cellClass`, `renderCell`, `renderHeader` | | | defaults for columns without their own |
| `rowClass` | `(rowIndex) => string` | | a class per row |
| `renderEmpty` | `(el, { filtered }) => void \| cleanup` | "No rows" | the empty state |

#### Sort and filter

| Option | Type | |
|---|---|---|
| `sort`, `filter`, `columnFilter` | `SortItem[]`, `FilterItem[]`, `ColumnFilterItem[]` | the starting sort and filters |
| `controlled` | `{ sort?, filter?, columnFilter? }` | make them [controlled](#controlled-state) |
| `selectedRows` | `{ checks: RowCheck[] }` | checked rows (applied when it changes) |
| `columnOrder` | `(string \| number \| [first, last])[]` | column keys in display order (compact runs for `getColumn` tables) |
| `pinnedColumns` | `number` | columns marked `pinned` | pin this many leading columns |

#### Events

| Option | Receives |
|---|---|
| `onSortChange` | `SortItem[]` |
| `onFilterChange` | `FilterItem[]` |
| `onColumnFilterChange` | `ColumnFilterItem[]` |
| `onSelectionChange` | `{ active, text, ranges, rows, cols, cells }` |
| `onCopy` | `{ ok, cells, rows, cols, ms, reason? }` |
| `onColumnResize` | `{ column, key, width }`, when the user lets go |
| `onColumnOrderChange` | column keys in their new order, after a drag |
| `onRowSelectionChange` | `{ checks }` |
| `onCellClick`, `onCellDoubleClick`, `onCellContextMenu` | the cell's context plus `key` and `event` ([cell events](#cell-events)) |
| `onViewChange` | `{ what, pending, progress? }` while a sort or filter runs, then `{ what, ok, rows, reason? }` or `{ what, cancelled: true }` |
| `onError` | `(error, { kind: 'layout' \| 'cells' \| 'labels' })`; errors are logged when this is not set |
| `onReady` | `(grid)` once the grid is drawn |

### Column options

| Option | Type | |
|---|---|---|
| `key` | `string` | the row field, and the column's id in sort, filter and events |
| `title` | `string` | header text |
| `type` | `'text' \| 'number' \| 'date'` | alignment and the default filter |
| `width` | `number` | px |
| `align` | `'start' \| 'end' \| 'center'` | |
| `filter` | see [sorting and filtering](#sorting-and-filtering) | |
| `sortable`, `resizable`, `hidden` | `boolean` | |
| `pinned` | `boolean` | stays at the start while scrolling sideways |
| `reorderable` | `boolean` | `false`: cannot be dragged elsewhere |
| `group` | `string` | group name for the column chooser |
| `format` | `(value, ctx) => string` | text shown in the cell |
| `cellClass` | `(value, ctx) => string` | a class per cell |
| `className`, `headerClass` | `string` | classes for every cell, or the header |
| `renderCell` | `(el, ctx) => void \| cleanup` | your own cell content |
| `renderHeader` | `(el, ctx) => void \| cleanup` | your own header content |
| `value` | `(row) => any` | a computed value (`createArraySource`) |
| `compare` | `(a, b) => number` | a custom sort order (`createArraySource`) |

### Grid methods

| Method | |
|---|---|
| `ready` | a promise that resolves once the grid is drawn |
| `setOptions(partial)` | change any option; scroll position, sort and filters are kept |
| `refresh()` | reload the visible data (it changed on the server) |
| `getRow(rowIndex)` | the record behind a visible row, when loaded |
| `getRowSelection()`, `setRowSelection(sel)`, `checkedCount()` | checked rows |
| `getColumnOrder()`, `setColumnOrder(keys)` | column order |
| `repaint()` | redraw cells (your `format` or `renderCell` output changed) |
| `getQuery()`, `getSort()`, `getFilter()`, `getColumnFilter()` | the current sort and filters |
| `setSort(sort)`, `setFilter(filter)`, `setColumnFilter(list)` | change them; resolve to `false` if refused |
| `toggleSort(column, additive?)` | what a header click does |
| `openFilter(column)`, `closeFilter()` | the filter dialog |
| `cancel()` | stop a sort or filter that is still running |
| `scrollToCell(row, col?)` | bring a cell into view |
| `getSelection()`, `setSelection(sel)`, `selectAll()`, `selectionInfo()` | selection |
| `copySelection()` | copy, as with ⌘C / Ctrl+C |
| `cellValue(row, col)`, `cellText(row, col)` | a loaded cell's value or text |
| `setColumnWidth(col, px)` | |
| `setMerges(merges)` | merged cells: `[{ r0, c0, nr, nc, label? }]` |
| `rowCount`, `columnCount`, `visibleRange` | sizes and what is on screen |
| `levels`, `showLevel(axis, level)`, `expandAll(axis)`, `toggleGroup(axis, level, group)` | pivots |
| `stats()` | render and cache counters, for profiling |
| `focus()`, `destroy()` | |

### Data source

| Member | | |
|---|---|---|
| `getRows({ offset, limit, sort, filter, query, signal, onProgress? })` | this or `getCells` | `{ rows, total, totalUnfiltered? }` |
| `getCells({ rects, query, signal })` | this or `getRows` | cells for each rect |
| `getLayout({ query, signal, onProgress })` | with `getCells`: needed for filtering and pivots | `{ rowCount, totalRowCount?, maxSortRows?, maxFilterRows? }` or a pivot layout; may report [progress](#slow-sorts-and-filters) |
| `rowIdAt(position, query)` | optional | a row's id without its record ([rows by id](#rows-by-id)) |
| `indexOfRow(id, query, getRowId)` | optional | a row's position in the view, `-1` if not in it, `null` if unknown |
| `getFilterValues({ column, key, search, limit, query, signal })` | optional | `{ values, total?, matches? }` |
| `getColumns({ start, count, query, signal })` | optional | `ColumnDescription[]`: columns described on demand ([very wide tables](#very-wide-tables)) |
| `getLabels({ axis, level, start, count, query, signal })` | optional | header titles you did not put in the columns |
| `maxRectsPerRequest`, `maxCellsPerRequest` | optional | at most this many rects (default 400) or cells (default 20,000) per `getCells` call |
| `clearCache()` | optional | drop cached data (`refresh()` calls it) |

### TypeScript

Every option, callback and data source shape has a type, exported by name: `GridOptions`, `ColumnDef<Value, Row>`,
`DataSource`, `Query`, `SortItem`, `FilterItem`, `CellContext`, `HeaderContext`, `SelectionInfo`, `GridStats` and
more. They are generated from the source, so they always match the code. `createArraySource<Row>(rows)` types
`setRows`, `rowAt` and each column's `value(row)`.

The low-level pieces (`GridEngine`, `createTableModel`, `createPivotModel`, `GridModel`, the axes and `BlockCache`)
are exported for custom layouts and tooling, and may change in any release. `GridEngine` was exported as
`VirtualGrid` before 0.2; that name still works but is deprecated, since the React component has the same name.

## FAQ

**Nothing shows up.** Give the container a height (see [Quick start](#quick-start)).

**Can users edit cells?** Not built in yet. Render an input with `renderCell`, save the change, then call
`grid.refresh()` (or `source.setRows()` and `grid.refresh()` for in-memory rows).

**Can I export to Excel?** Copying a selection pastes straight into Excel and Google Sheets. File export is not
built in.

**Can it show a row count without `getLayout`?** Pass `rowCount` instead. Sorting still works; filtering is
off, since the grid can't ask how many rows match.

**Does it work with Vue, Svelte or Angular?** Yes. Create the grid when your component mounts, call
`grid.setOptions()` when inputs change, and `grid.destroy()` when it unmounts.

## License

[MIT](https://github.com/borealjs/grid/blob/main/LICENSE)
