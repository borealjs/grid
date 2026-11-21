import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The "Server" tabs talk to the reference server (npm start in the repo root, port 5174).
// `--mode pages` builds the static demo for GitHub Pages (https://borealjs.github.io/grid/):
// served under /grid/, with the server tabs answered in the browser (see src/inBrowserApi.js).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'pages' ? '/grid/' : '/',
  server: { port: 5175, proxy: { '/api': 'http://localhost:5174' } },
}));
