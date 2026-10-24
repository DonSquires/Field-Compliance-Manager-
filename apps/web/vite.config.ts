import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { configDefaults } from 'vitest/config';
import { execSync } from 'node:child_process';
import type { Plugin } from 'vite';

// One identity per deployed build. An open tab compares it with /version.json so a user is told
// when a newer release is live instead of working on a stale bundle indefinitely.
function resolveBuildId() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return `local-${Date.now()}`; }
}
const BUILD_ID = resolveBuildId();

function buildVersionManifest(): Plugin {
  return {
    name: 'fcm-build-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) });
    },
  };
}

// NOTE: bundler choice is a documented assumption, not verified against the
// original repository (Bob never confirmed vite.config.* there). Vite is
// the standard match for a bare main.tsx + BrowserRouter entry; revisit if
// that assumption is later contradicted by evidence.
export default defineConfig({
  plugins: [react(), buildVersionManifest()],
  define: { __APP_BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: {
    // Mermaid is loaded only when Bob renders a diagram; its lazy runtime is
    // intentionally larger than the initial application vendor budget.
    chunkSizeWarningLimit: 3500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/mermaid/') || id.includes('/@mermaid-js/') || id.includes('/cytoscape') || id.includes('/d3/') || id.includes('/d3-') || id.includes('/dagre') || id.includes('/katex/') || id.includes('/dompurify/') || id.includes('/marked/') || id.includes('/roughjs/') || id.includes('/khroma/') || id.includes('/fastdom/') || id.includes('/@upsetjs/')) return 'vendor-mermaid';
          if (id.includes('/@tiptap/')) return 'vendor-editor';
          if (id.includes('/leaflet/')) return 'vendor-maps';
          if (id.includes('/read-excel-file/')) return 'vendor-spreadsheets';
          if (id.includes('/tus-js-client/')) return 'vendor-upload';
          if (id.includes('/date-holidays/')) return 'vendor-calendar';
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
    exclude: [...configDefaults.exclude],
  },
});
