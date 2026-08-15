import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// В dev режиме фронт крутится на 5173 и проксирует /api на бэкенд (8080).
// В проде собранная статика отдаётся самим Fastify из server/public.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
});
