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
        // Critical for PWA updates:
        // 1. Delete old caches immediately so they don't conflict
        cleanupOutdatedCaches: true,
        // 2. Take control of the page immediately, don't wait for a reload
        clientsClaim: true,
        skipWaiting: true,
        // 3. Don't cache the index.html too aggressively (network first for navigation)
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
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-utils': ['mqtt', 'jszip'],
          'vendor-ui': ['lucide-react'],
        }
      }
    }
  },
});