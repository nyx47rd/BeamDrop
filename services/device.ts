export class DeviceService {
  private wakeLock: any = null;
  private backgroundAudio: HTMLAudioElement | null = null;

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

    // Check permission again
    if (Notification.permission === 'granted') {
      try {
        // Mobile browsers might vibrate automatically, or we can use navigator.vibrate
        if ('vibrate' in navigator) navigator.vibrate(200);

        new Notification(title, {
          body,
          icon: '/icon.svg',
          badge: '/icon.svg',
          tag: 'beamdrop-transfer', // prevents stacking too many
          renotify: true,
          requireInteraction: false // Disappear automatically
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
   * Enables a silent audio loop to trick mobile browsers (iOS/Android) 
   * into keeping the tab active in the background during transfer.
   */
  public enableBackgroundMode() {
    if (this.backgroundAudio) return;

    // A tiny silent MP3 base64
    const silentMp3 = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTSVMAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD//////////////////////////////////////////////////////////////////wAAAAAATGF2YzU4LjU0AAAAAAAAAAAAAAAAAAAAAAAAAAAACCAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASIAAAAAExbtAAAA0AAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASIAAAAAExbtAAAA0AAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASIAAAAAExbtAAAA0AAAAAAAAAAAA';

    this.backgroundAudio = new Audio(silentMp3);
    this.backgroundAudio.loop = true;
    this.backgroundAudio.volume = 0.01; // Non-zero volume is required by some browsers, but effectively silent
    
    this.backgroundAudio.play().then(() => {
        console.log("Background persistence enabled (Silent Audio)");
    }).catch(e => {
        console.warn("Background audio blocked (interaction needed first)", e);
    });
  }

  public disableBackgroundMode() {
    if (this.backgroundAudio) {
        this.backgroundAudio.pause();
        this.backgroundAudio = null;
        console.log("Background persistence disabled");
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