import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
// @ts-ignore
import { registerSW } from 'virtual:pwa-register';

// Auto-update service worker with robust handling
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    console.log("PWA update available, refreshing...");
    // Force the update to apply immediately
    updateSW(true);
  },
  onOfflineReady() {
    console.log("PWA ready for offline use");
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);