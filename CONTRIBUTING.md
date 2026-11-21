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

| Command | What it does |
|---|---|
| `npm start` | demo server and the plain JavaScript demo at http://localhost:5174 |
| `npm run dev:react` | the React demo at http://localhost:5175 (keep `npm start` running) |
| `npm run build:demo` | the static live demo (no server) in `examples/react/dist`; deployed to GitHub Pages from `main` |
| `npm test` | tests |
| `npm run typecheck` | checks the TypeScript types against `test/types` |

The repository is an npm workspace:

| Folder | |
|---|---|
| `packages/grid-core` | `@borealjs/grid-core`: the grid (plain ES modules, no build step) |
| `packages/react-grid` | `@borealjs/react-grid`: the React component and hooks |
| `examples/` | the two demos |
| `server.mjs` | demo server: the `/api` protocol over HTTP, plus the demo pages |
| `demo-backend.mjs` | the demo backend's data and request handling; the static live demo runs it in the browser |
| `test/` | tests and type tests |

## Pull requests

- Keep each pull request to one change, and add a test when you fix a bug or add an option.
- When you change the public API, update `index.d.ts` and the package README in the same pull request.
- Run `npm test` and `npm run typecheck` before you push; CI runs both on Node 20, 22 and 24.

## Releases

Maintainers release by setting the version and publishing a GitHub release:

```bash
npm run version-packages -- 0.2.0
```

Commit, push, then create a release with the tag `v0.2.0`. The release workflow tests and publishes both
packages to npm. Versions with a suffix such as `0.2.0-beta.0` are published under the `next` tag.
