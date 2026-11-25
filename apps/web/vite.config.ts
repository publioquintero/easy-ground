import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Lazily imported libraries: pre-bundle them at startup so Vite doesn't re-optimize
  // mid-session (which reloads the page and can load two copies of React).
  optimizeDeps: { include: ['leaflet', 'react-leaflet', 'pdfjs-dist', 'tesseract.js', 'zxing-wasm/reader'] },
  build: {
    rollupOptions: {
      output: {
        // Emit the pdf.js worker (.mjs) as .js: many servers (nginx's default mime.types)
        // serve .mjs as application/octet-stream, which browsers refuse to run as a module.
        assetFileNames: (asset) =>
          asset.names?.some((n) => n.endsWith('.mjs')) ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    host: true, // reachable from the iPhone on the same network
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
});
