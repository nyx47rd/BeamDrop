export class DeviceService {
  private wakeLock: any = null;

  /**
   * Request permission to send notifications.
   */
  public async requestNotificationPermission() {
    if (!('Notification' in window)) return;
    
    // Always request unless explicitly denied
    if (Notification.permission !== 'denied') {
      await Notification.requestPermission();
    }
  }

  /**
   * Send a system notification using Service Worker if available (Standard for Mobile).
   */
  public async sendNotification(title: string, body?: string) {
    if (!('Notification' in window)) return;

    if (Notification.permission === 'granted') {
      try {
        if ('vibrate' in navigator) {
            try { navigator.vibrate(200); } catch (e) {}
        }

        const options: any = {
          body,
          icon: '/icon.svg',
          badge: '/icon.svg',
          tag: 'beamdrop-transfer',
          renotify: true,
          requireInteraction: false,
          silent: false
        };

        // Priority 1: Use Service Worker (Critical for Android/iOS PWA)
        if ('serviceWorker' in navigator) {
            const registration = await navigator.serviceWorker.getRegistration();
            if (registration && 'showNotification' in registration) {
                await registration.showNotification(title, options);
                return;
            }
        }

        // Priority 2: Fallback to Classic API (Desktop / Dev)
        new Notification(title, options);

      } catch (e) {
        console.error("Notification failed", e);
      }
    }
  }

  /**
   * Keep the Screen ON (Wake Lock API)
   * This is the standard way to prevent the phone from sleeping during transfer.
   */
  public async enableWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
        console.log("Screen Wake Lock: Active");
      } catch (err) {
        console.warn("WakeLock failed:", err);
      }
    }
  }

  public async disableWakeLock() {
    if (this.wakeLock !== null) {
      await this.wakeLock.release();
      this.wakeLock = null;
      console.log("Screen Wake Lock: Released");
    }
  }

  /**
   * Re-acquire lock if user switches apps and comes back
   */
  public initVisibilityListener() {
    document.addEventListener('visibilitychange', async () => {
      if (this.wakeLock !== null && document.visibilityState === 'visible') {
        // Re-request lock when app comes to foreground
        await this.enableWakeLock();
      }
    });
  }
}

export const deviceService = new DeviceService();
deviceService.initVisibilityListener();