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
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts'],
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
