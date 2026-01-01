
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Ensure Vite knows exactly where the public folder is
  publicDir: 'public',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // REMOVED 'banner.png' from here to force network fetch
      includeAssets: ['icon.svg', 'favicon.png', 'apple-touch-icon.png', 'notification-icon.svg'],
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: '/index.html',
        // IMPORTANT: Deny list ensures 404s are actual 404s for images, not index.html
        navigateFallbackDenylist: [
            /^\/api\//, 
            /sitemap\.xml$/, 
            /robots\.txt$/,
            /.*\.png$/,
            /.*\.jpg$/,
            /.*\.jpeg$/,
            /.*\.svg$/,
            /.*\.ico$/,
            /.*\.json$/
        ],
        runtimeCaching: [
          {
            // NetworkOnly strategy for images ensures we always see the server reality
            // This is crucial for debugging missing files
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'NetworkOnly', 
            options: {
              cacheName: 'images',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24, 
              },
            },
          },
        ]
      },
      manifest: {
        name: 'BeamDrop P2P',
        short_name: 'BeamDrop',
        description: 'Secure, serverless P2P file transfer directly between devices using WebRTC.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          },
          {
            src: 'favicon.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'favicon.png', 
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          }
        ]
      }
    })
  ],
  build: {
    outDir: 'dist',
    target: 'esnext',
    minify: 'esbuild',
    cssMinify: true,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-ui';
          }
          if (id.includes('node_modules/jszip')) {
            return 'vendor-utils';
          }
        }
      }
    }
  },
});
