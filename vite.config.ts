import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  // Public pages have real addresses (/store/<id>/<name>), so files load from the site's root. The
  // self-contained demo page keeps relative links so it opens from anywhere.
  base: mode === 'single-file' ? './' : '/',
  plugins: [react()],
  build: {
    // `vite build --mode single-file` embeds images in the bundle, for a self-contained demo page.
    assetsInlineLimit: mode === 'single-file' ? 100_000_000 : 4096,
    // No inline module-preload polyfill, so the Content-Security-Policy (netlify.toml) can keep
    // script-src to 'self' with no 'unsafe-inline'. Every target browser preloads modules natively.
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Libraries change far less often than the app, so they get their own files and stay
        // cached in visitors' browsers across deploys.
        manualChunks: mode === 'single-file' ? undefined : {
          react: ['react', 'react-dom'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },
}))
