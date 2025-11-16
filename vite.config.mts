import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 5173,
    // 显式开启 Vite 开发服务器的 CORS 支持，默认允许任意来源
    cors: true
  },
  preview: {
    // 预览环境同样开启 CORS
    cors: true
  },
  build: {
    outDir: 'dist'
  }
});


