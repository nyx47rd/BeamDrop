import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: null,
      },
      manifest: {
        name: 'BeamDrop P2P',
        short_name: 'BeamDrop',
        description: 'Secure, serverless P2P file transfer directly between devices using WebRTC.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        orientation: 'portrait',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      }
    })
  ],
  build: {
    outDir: 'dist',
    target: 'esnext', // Reduces bundle size by removing legacy polyfills
    minify: 'esbuild', // Faster and efficient
    cssMinify: true,
    reportCompressedSize: false, // Speeds up build
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React Core (High Priority, Cached often)
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react';
          }
          // UI Libs (Medium Priority)
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-ui';
          }
          // Utilities
          if (id.includes('node_modules/jszip')) {
            return 'vendor-utils';
          }
          // IMPORTANT: 'mqtt' is purposefully EXCLUDED here.
          // Since it is dynamically imported in the code, excluding it lets Vite
          // create a separate async chunk that is ONLY loaded when connecting.
        }
      }
    }
  },
});