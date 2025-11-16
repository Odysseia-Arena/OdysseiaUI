import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    host: '0.0.0.0' // 允许局域网访问
  },
  preview: {
    port: 4173,
    host: '0.0.0.0' // 允许局域网访问
  },
  build: {
    outDir: 'dist'
  }
});


