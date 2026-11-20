import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Firebase changes rarely — keep it in its own long-cached chunk.
        manualChunks: (id) => (id.includes('node_modules/') ? 'firebase' : undefined),
      },
    },
  },
});
