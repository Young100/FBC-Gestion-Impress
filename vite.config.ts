import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        scope: '/client/',
        includeAssets: [
          'icon.svg',
          'apple-touch-icon.png',
          'pwa-192x192.png',
          'pwa-512x512.png',
          'pwa-maskable-512x512.png',
        ],
        manifest: {
          id: '/client/',
          name: 'FBC Print — Commande & Suivi d’Impression',
          short_name: 'FBC Print',
          description:
            'Commandez vos impressions grand format et supports pro sans compression, avec devis PDF et suivi en temps réel.',
          lang: 'fr',
          theme_color: '#26547C',
          background_color: '#EDF2F4',
          display: 'standalone',
          orientation: 'any',
          scope: '/client/',
          start_url: '/client/',
          categories: ['business', 'productivity'],
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          navigateFallback: '/index.html',
          navigateFallbackAllowlist: [/^\/client(\/.*)?$/],
          navigateFallbackDenylist: [
            /^\/api\//,
            /^\/fbcprintgestionadmin/,
            /^\/server-views\//,
          ],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'google-fonts-stylesheets',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-webfonts',
                expiration: {
                  maxEntries: 20,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
          navigateFallback: 'index.html',
          navigateFallbackAllowlist: [/^\/client(\/.*)?$/],
        },
      }),
      // Ensures built dist/server-views/atelier.html keeps its own isolated
      // atelier-manifest.webmanifest instead of the client manifest injected by VitePWA.
      {
        name: 'preserve-atelier-pwa-manifest',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) return;
          const atelierHtml = path.resolve(
            __dirname,
            'dist/server-views/atelier.html'
          );
          if (!fs.existsSync(atelierHtml)) return;
          let html = fs.readFileSync(atelierHtml, 'utf-8');
          html = html.replace(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s*\/?>/gi, '');
          if (!html.includes('/atelier-manifest.webmanifest')) {
            html = html.replace(
              '</head>',
              '  <link rel="manifest" href="/atelier-manifest.webmanifest" />\n  </head>'
            );
          }
          fs.writeFileSync(atelierHtml, html, 'utf-8');
        },
      },
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          admin: path.resolve(__dirname, 'server-views/atelier.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      allowedHosts: ['fbc-print.onrender.com'],
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
