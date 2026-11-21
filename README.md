# BorealJS Grid

A virtual data grid for any number of rows and columns, as two packages:

| Path | Package | |
|---|---|---|
| `packages/grid-core` | `@borealjs/grid-core` | framework-free grid, data sources, styles, types |
| `packages/react-grid` | `@borealjs/react-grid` | `<VirtualGrid>` with React cells, headers and filters |
| `examples/vanilla` | | the original demo (pivot / flat, a billion rows) on the public API |
| `examples/react` | | Vite app: in-memory rows with React cells, custom filter, controlled sort; server pivot; 1B × 1M |
| `server.mjs` | | reference backend for the HTTP protocol (procedural data, any size, simulated latency) |
| `test/` | | `npm test` (node:test, no dependencies) |

```bash
npm install
npm start            # reference server + vanilla demo: http://localhost:5174
npm run dev:react    # React example: http://localhost:5175 (server tabs need npm start too)
npm test
```

## Design choices (and why)

- **One data-source object of callbacks** (`getCells`, optional `getLayout`, `getFilterValues`, `getLabels`)
  instead of fixed endpoints, like MUI X `dataSource.getRows` and AG Grid's server-side datasource. The grid
  keeps everything hard on its side: caching (LRU by cell budget), de-duplication, prioritizing what is near
  the viewport, batching scattered strips into one call, aborting what scrolled away. Unlike row-only APIs,
  requests are 2-D rectangles, so a million columns work the same way as a billion rows.
- **A structured query** (`sort`, `filter`, `columnFilter` with column index *and* key) that maps directly
  onto SQL / search engines; custom filters pass through as `{ op, value }`.
- **Customization in layers**: `format` / `cellClass` (cheapest) → `renderCell` / `renderHeader` → custom
  filter dialogs → `messages` and `--vg-*` theme tokens → feature switches → a custom `model` for layouts
  the table and pivot do not cover.
