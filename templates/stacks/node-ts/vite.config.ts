import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The React app lives in src/client and is built into dist/client.
// In production the API server serves those files from the same container.
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // During `npm run dev` the API runs on :8080; Vite forwards these paths to it.
    // `/api` as a pattern, not a prefix: a plain '/api' would also forward the client's own
    // module /api.ts (src/client/api.ts) and the page would not load.
    proxy: {
      '^/api(?:/|$)': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/readyz': 'http://localhost:8080',
    },
  },
});
