import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: 'index.html',
        agua: 'lab/agua/index.html', // Río Vivo water laboratory (isolated from the game)
        aguaTests: 'lab/agua/tests.html',
      },
    },
  },
  worker: { format: 'es' },
});
