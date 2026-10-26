import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

const TARGET = 'http://localhost:8081';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: '../public',
    emptyOutDir: false,
    sourcemap: false,
    cssMinify: false,
    rollupOptions: {
      output: {
        // vite 8 起打包器换成 rolldown：manualChunks 只接受**函数**，对象形式会报
        // 「manualChunks is not a function」直接构建失败。这里改成等价的分包函数。
        manualChunks(id: string) {
          if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender')) return 'echarts';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': TARGET,
      '/flags': TARGET,
      '/i18n': TARGET,
      '/vendor': TARGET,
      '/custom.css': TARGET,
      '/os-': TARGET,
      '/logo': TARGET,
    },
  },
});
