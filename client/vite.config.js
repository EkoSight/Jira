import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The photo editor's face finder runs in the browser. Its engine is served
// from TaskFlow itself (never a CDN): copied from node_modules into
// vendor/mediapipe/<version>/, with gzip copies the server sends when it can.
const require = createRequire(import.meta.url);
// the package's exports hide package.json, so find it from the module it does export
const MP_DIR = path.join(path.dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
const MP_VERSION = JSON.parse(fs.readFileSync(path.join(MP_DIR, '..', 'package.json'), 'utf8')).version;
const MP_BASE = `vendor/mediapipe/${MP_VERSION}`;
function mediapipeAssets() {
  return {
    name: 'taskflow-mediapipe-assets',
    configureServer(server) {
      server.middlewares.use(`/${MP_BASE}/`, (req, res, next) => {
        const file = path.join(MP_DIR, path.basename(req.url.split('?')[0]));
        if (!fs.existsSync(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        return fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const name of fs.readdirSync(MP_DIR)) {
        const source = fs.readFileSync(path.join(MP_DIR, name));
        this.emitFile({ type: 'asset', fileName: `${MP_BASE}/${name}`, source });
        if (name.endsWith('.wasm')) this.emitFile({ type: 'asset', fileName: `${MP_BASE}/${name}.gz`, source: zlib.gzipSync(source, { level: 9 }) });
      }
    },
  };
}

// VITE_BASE lets the built PWA be served from a sub-path of the existing
// application (e.g. https://app.ekosight.com/taskflow/).
export default defineConfig(({ mode }) => ({
  base: process.env.VITE_BASE || '/',
  plugins: [react(), mediapipeAssets()],
  define: { __MEDIAPIPE_BASE__: JSON.stringify(MP_BASE) },
  server: {
    port: 5173,
    // listen on the LAN too, so the PWA can be opened on a phone during development
    host: true,
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
