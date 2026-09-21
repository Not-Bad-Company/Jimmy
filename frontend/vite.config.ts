import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // listen on all interfaces (LAN access from phone/tablet)
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3000',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
