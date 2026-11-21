import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The "Server" tabs talk to the reference server (npm start in the repo root, port 5174) through /api.
// `--mode pages` builds the static live demo for GitHub Pages (https://borealjs.github.io/grid/):
// served under /grid/, with every /api call answered in the browser (see src/inBrowserApi.js).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'pages' ? '/grid/' : '/',
  server: { port: 5175, proxy: { '/api': 'http://localhost:5174' } },
  preview: { port: 4173 },
}));
