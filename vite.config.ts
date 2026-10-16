import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, cpSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const cesiumRoot = resolve(projectRoot, 'node_modules/cesium/Build/Cesium');
const cesiumFolders = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];
const mimeTypes: Record<string, string> = { js: 'text/javascript', json: 'application/json', css: 'text/css', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', wasm: 'application/wasm', xml: 'application/xml' };

/** Cesium loads workers and textures at runtime; keep their paths stable in Vite and Vercel. */
function cesiumAssets(): Plugin {
  return {
    name: 'culture-cesium-assets',
    configureServer(server) {
      server.middlewares.use('/cesium', (req, res, next) => {
        let relative: string;
        try { relative = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, ''); } catch { return next(); }
        if (!cesiumFolders.includes(relative.split('/')[0])) return next();
        const file = resolve(cesiumRoot, relative);
        if (!file.startsWith(cesiumRoot + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', mimeTypes[file.split('.').pop() ?? ''] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const folder of cesiumFolders) cpSync(resolve(cesiumRoot, folder), resolve(projectRoot, 'dist/client/cesium', folder), { recursive: true });
    },
  };
}

export default defineConfig({
  root: 'web', plugins: [react(), cesiumAssets()],
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium/') },
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '^/api(?:/|$)': 'http://127.0.0.1:4317' } },
});
