# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

[Open an issue](https://github.com/borealjs/grid/issues) with the package version, your browser, what you
did, what you expected and what happened. A small example (a CodeSandbox, StackBlitz or a few lines of code)
makes it much quicker to fix.

## Working on the code

You need Node 20 or newer.

```bash
git clone https://github.com/borealjs/grid.git && cd grid && npm install
```

`npm install` also builds the packages: [tsdown](https://tsdown.dev) bundles each one into a minified
`dist/index.js` and a single `dist/index.d.ts` (config in `packages/*/tsdown.config.ts`).

| Command | What it does |
|---|---|
| `npm run build` | builds both packages; `npm start`, `npm test` and `build:demo` run it first |
| `npm run dev` | everything for working on the grid: the demo server, the React demo with hot reload, and a watch build of grid-core; start page at http://localhost:5174 |
| `npm start` | the demo server only (`/api`, the plain JavaScript example and the playground) at http://localhost:5174 |
| `npm run dev:react` | the live demo (React) alone at http://localhost:5175, with hot reload of the demo and of the packages' TypeScript sources (needs the demo server for its server tabs) |
| `npm run build:demo` | the static live demo (no server) in `examples/react/dist`; deployed to GitHub Pages from `main` |
| `npm run preview:demo` | builds it and serves it at http://localhost:4173/grid/, as it will look on GitHub Pages |
| `npm test` | tests: the public API against the built bundles, internals from the TypeScript sources (via tsx) |
| `npm run typecheck` | builds, type-checks both packages (`tsc`, no output), then the published types against `test/types` |

The repository is an npm workspace:

| Folder | |
|---|---|
| `packages/grid-core` | `@borealjs/grid-core`: the grid, in TypeScript (see below) |
| `packages/react-grid` | `@borealjs/react-grid`: the React component and hooks |
| `examples/` | `index.html`: the start page; `react/`: the live demo (`src/inBrowserApi.js` runs the demo backend in the browser on GitHub Pages); `vanilla/`: the plain JavaScript example; `playground/`: CSV or generated data with simulated latency |
| `server.mjs` | demo server: the `/api` protocol over HTTP, plus the demo pages |
| `demo-backend.mjs` | the demo backend's data and request handling; the static live demo runs it in the browser |
| `test/` | tests and type tests |

### Where things are in `packages/grid-core/src`

| Path | |
|---|---|
| `index.ts` | the public exports |
| `types.ts` | every public type (options, columns, data sources, events): the API, documented |
| `grid.ts` | `createGrid` and the `Grid` class: options, the public query format, rebuilds |
| `query.ts` | the query in its public and internal formats, and request signatures |
| `sources/` | `createArraySource` (in memory) and `createHttpSource` (the reference protocol) |
| `model/` | what the engine draws: the `GridModel` contract, the table and pivot models |
| `axes/` | item index ↔ pixel offset: uniform, resizable, and tree axes (pivots) |
| `engine/engine.ts` | `GridEngine`: scrolling, rendering, selection, keyboard, data requests |
| `engine/*` | the engine's parts: cache and cache keys, header / merge / selection layers, filter dialog, clipboard, notices |
| `grid.css` | styles (published as `@borealjs/grid-core/style.css`) |

Pure logic (axes, merges, selection geometry, clipboard formats, models) is unit-tested without a DOM in
`test/units.test.mjs`; prefer adding logic there rather than in the engine.

## Pull requests

- Keep each pull request to one change, and add a test when you fix a bug or add an option.
- The published types are generated from the source. When you change the public API, document it in
  `src/types.ts`, add a case to `test/types/usage.tsx`, and update the package README in the same pull request.
- Run `npm test` and `npm run typecheck` before you push; CI runs both on Node 20, 22 and 24.

## Releases

Maintainers release by setting the version and publishing a GitHub release:

```bash
npm run version-packages -- 0.2.0
```

Commit, push, then create a release with the tag `v0.2.0`. The release workflow tests and publishes both
packages to npm. Versions with a suffix such as `0.2.0-beta.0` are published under the `next` tag.
