import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// The API also serves the hosted APK under /downloads.
const target = process.env.API_PROXY ?? 'http://localhost:8080';
const proxy = { '/api': { target }, '/downloads': { target } };

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // The Android app ships its assets inside the APK; no service worker there.
    mode !== 'native' &&
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icons/favicon.svg', 'icons/apple-touch-icon.png'],
        manifest: {
          name: 'Gauntlet',
          short_name: 'Gauntlet',
          description: 'Fitness challenges with your friends, powered by SparkyFitness.',
          theme_color: '#0c0c0d',
          background_color: '#0c0c0d',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          categories: ['fitness', 'health', 'sports'],
          // Long-press the installed app's icon.
          shortcuts: [
            {
              name: 'Sync now',
              url: '/?sync=1',
              icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
            },
            {
              name: 'New challenge',
              url: '/c/new',
              icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
            },
          ],
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/icons/maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//, /^\/(privacy|terms|delete-account|downloads)/],
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // Web Push: show notifications and open the app when one is tapped (public/push-sw.js).
          importScripts: ['/push-sw.js'],
          // API responses are live data; never serve them from cache.
          runtimeCaching: [{ urlPattern: /\/api\//, handler: 'NetworkOnly' }],
        },
      }),
  ],
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Big libraries that rarely change get their own files, so an app update does not make
        // the web app download them again.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (
            /[\\/]node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(react-dom|react|scheduler)[\\/]/.test(
              id,
            )
          )
            return 'react';
          if (/[\\/]react-router[\\/]/.test(id)) return 'router';
          if (/[\\/]@tanstack[\\/]/.test(id)) return 'query';
          return undefined;
        },
      },
    },
  },
}));
