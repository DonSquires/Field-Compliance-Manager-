import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// NOTE: bundler choice is a documented assumption, not verified against the
// original repository (Bob never confirmed vite.config.* there). Vite is
// the standard match for a bare main.tsx + BrowserRouter entry; revisit if
// that assumption is later contradicted by evidence.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@supabase/')) return 'vendor-supabase';
          if (id.includes('lucide-react')) return 'vendor-icons';
          if (id.includes('react-router') || id.includes('/react/') || id.includes('/react-dom/')) {
            return 'vendor-react';
          }
          return 'vendor';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
