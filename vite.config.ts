import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { missingSupabaseSettings } from './src/lib/buildCheck'

export default defineConfig(({ mode }) => ({
  // Public pages have real addresses (/store/<id>/<name>), so files load from the site's root. The
  // self-contained demo page keeps relative links so it opens from anywhere.
  base: mode === 'single-file' ? './' : '/',
  plugins: [
    react(),
    {
      name: 'require-supabase-settings',
      apply: 'build',
      buildStart() {
        const problem = missingSupabaseSettings({ ...loadEnv(mode, process.cwd(), ''), ...process.env }, mode)
        if (problem) throw new Error(problem)
      },
    },
  ],
  build: {
    // `vite build --mode single-file` embeds images in the bundle, for a self-contained demo page.
    assetsInlineLimit: mode === 'single-file' ? 100_000_000 : 4096,
    // No inline module-preload polyfill, so the Content-Security-Policy (netlify.toml) can keep
    // script-src to 'self' with no 'unsafe-inline'. Every target browser preloads modules natively.
    modulePreload: { polyfill: false },
  },
}))
