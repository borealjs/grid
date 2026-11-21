import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The "Server" tabs talk to the reference server (npm start in the repo root, port 5174).
export default defineConfig({
  plugins: [react()],
  server: { port: 5175, proxy: { '/api': 'http://localhost:5174' } },
});
