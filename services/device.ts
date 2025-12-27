export class DeviceService {
  private wakeLock: any = null; // WakeLockSentinel type is not globally available in all TS configs yet

  /**
   * Request permission to send notifications.
   */
  public async requestNotificationPermission() {
    if (!('Notification' in window)) return;
    
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  }

  /**
   * Send a system notification.
   */
  public sendNotification(title: string, body?: string) {
    if (!('Notification' in window)) return;

    if (Notification.permission === 'granted') {
      // Check if we are in background or foreground. 
      // Even if in foreground, some users like the banner confirmation.
      try {
        new Notification(title, {
          body,
          icon: '/icon.svg',
          badge: '/icon.svg',
          tag: 'beamdrop-transfer', // prevents stacking too many
          renotify: true
        } as any);
      } catch (e) {
        console.error("Notification failed", e);
      }
    }
  }

  /**
   * Keep the screen awake.
   */
  public async enableWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
        console.log('Screen Wake Lock acquired');

        this.wakeLock.addEventListener('release', () => {
          console.log('Screen Wake Lock released');
        });
      } catch (err) {
        console.error(`${err} - Wake Lock request failed`);
      }
    }
  }

  /**
   * Release the screen wake lock.
   */
  public async disableWakeLock() {
    if (this.wakeLock !== null) {
      await this.wakeLock.release();
      this.wakeLock = null;
    }
  }

  /**
   * Re-acquire lock if visibility changes (e.g. user tabs away and comes back)
   */
  public initVisibilityListener() {
    document.addEventListener('visibilitychange', async () => {
      if (this.wakeLock !== null && document.visibilityState === 'visible') {
        await this.enableWakeLock();
      }
    });
  }
}

export const deviceService = new DeviceService();
deviceService.initVisibilityListener();