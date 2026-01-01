
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Added banner.png to be explicitly included
      includeAssets: ['icon.svg', 'favicon.png', 'apple-touch-icon.png', 'notification-icon.svg', 'banner.png'],
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        // Fix 404 on routes: Serve index.html for all navigation requests
        navigateFallback: '/index.html',
        // CRITICAL FIX: Exclude images and static files from being handled by the SPA fallback
        // This ensures /banner.png is treated as a file, not a route
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
