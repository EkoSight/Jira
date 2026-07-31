import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_BASE lets the built PWA be served from a sub-path of the existing
// application (e.g. https://app.ekosight.com/taskflow/).
export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: mode !== 'production',
  },
}));
