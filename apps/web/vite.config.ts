import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const apiPort = Number(process.env.NODEPILOT_PORT ?? 4317);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@nodepilot/shared': path.resolve(import.meta.dirname, '../../packages/shared/src/index.ts') },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.NODEPILOT_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      // Keep the browser's Host/Origin as-is so the API's origin checks apply to dev traffic too.
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1500 },
});
