import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// GitHub Pages(하위 경로)에서도 돌도록 상대 경로로 빌드. 에디터 + 비교 화면 두 페이지
export default defineConfig({
  base: './',
  server: { port: 5317 },
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), compare: resolve(__dirname, 'compare.html') },
    },
  },
});
