import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// NOTE: bundler choice is a documented assumption, not verified against the
// original repository (Bob never confirmed vite.config.* there). Vite is
// the standard match for a bare main.tsx + BrowserRouter entry; revisit if
// that assumption is later contradicted by evidence.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
