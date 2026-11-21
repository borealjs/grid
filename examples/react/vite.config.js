import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = (path) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

// The "Server" tabs talk to the reference server (npm start in the repo root, port 5174) through /api.
// `--mode pages` builds the static live demo for GitHub Pages (https://borealjs.github.io/grid/):
// served under /grid/, with every /api call answered in the browser (see src/inBrowserApi.js).
// The grid packages are read from their TypeScript sources, so edits to them hot-reload here.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'pages' ? '/grid/' : '/',
  resolve: {
    alias: [
      { find: /^@borealjs\/grid-core$/, replacement: pkg('grid-core/src/index.ts') },
      { find: /^@borealjs\/react-grid$/, replacement: pkg('react-grid/src/index.ts') },
    ],
  },
  server: { port: 5175, strictPort: true, proxy: { '/api': 'http://localhost:5174' } },
  preview: { port: 4173 },
}));
