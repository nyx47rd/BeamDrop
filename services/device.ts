
// Base64 of a tiny 1x1 pixel silent MP4 video
// This is used to trick mobile browsers into keeping the screen on when the Native API fails.
const NO_SLEEP_VIDEO_BASE64 = "data:video/mp4;base64,AAAAHGZ0eXBNNEVAAAAAAAAAACMZnJlZQAAAAAAAAAAEAAvY21vb3YAAABsbXZoAAAAAgAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAGGlvZHMAAAAAEICAgAcAAAAAAAAAAAAAABx0cmFrAAAAXHRraGQAAAAuAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAABAAAAAAQAAAAAAABhmdHlwbXA0MgAAAABtcDQyaXNvbQAAAAx1ZHRhAAAAZ21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAlLWlsc3QAAAAZcHRvbwAAAAwAAAABZmZtcGVnAAAAAC0AAAAhZGF0YQAAAAEAAAAAMTAwLjEwMC4xMDAuMTAw/60AAABBst3R";

const ADJECTIVES = ['Red', 'Blue', 'Green', 'Fast', 'Silent', 'Cosmic', 'Neon', 'Swift'];
const ANIMALS = ['Fox', 'Eagle', 'Bear', 'Wolf', 'Hawk', 'Tiger', 'Falcon', 'Panda'];

export class DeviceService {
  private wakeLock: any = null;
  private noSleepVideo: HTMLVideoElement | null = null;
  private isLocking = false;
  private deviceName: string = '';

  constructor() {
    this.deviceName = localStorage.getItem('beamdrop_device_name') || this.generateRandomName();
    localStorage.setItem('beamdrop_device_name', this.deviceName);
  }

  private generateRandomName() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const num = Math.floor(Math.random() * 99) + 1;
    return `${adj} ${animal} ${num}`;
  }

  public getDeviceName(): string {
    return this.deviceName;
  }

  public setDeviceName(name: string) {
    this.deviceName = name.trim();
    localStorage.setItem('beamdrop_device_name', this.deviceName);
  }

  /**
   * Request permission to send notifications.
   */
  public async requestNotificationPermission() {
    if (!('Notification' in window)) return;
    
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
          icon: '/icon.svg', // Large icon (keeps the app style)
          badge: '/notification-icon.svg', // Small icon for status bar (Transparent Zap)
          tag: 'beamdrop-transfer',
          renotify: true,
          requireInteraction: false,
          silent: false
        };

        if ('serviceWorker' in navigator) {
            const registration = await navigator.serviceWorker.getRegistration();
            if (registration && 'showNotification' in registration) {
                await registration.showNotification(title, options);
                return;
            }
        }
        new Notification(title, options);
      } catch (e) {
        console.error("Notification failed", e);
      }
    }
  }

  /**
   * Hybrid Wake Lock: Native API + Video Fallback
   * Ensures screen stays on in iOS Safari and Android Chrome.
   */
  public async enableWakeLock() {
    if (this.isLocking) return;
    this.isLocking = true;

    // 1. Try Native Wake Lock API
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
        console.log("Screen Wake Lock: Active (Native)");

        // Crucial: Re-acquire if the system releases it automatically
        this.wakeLock.addEventListener('release', () => {
          console.log('Screen Wake Lock: Released by system');
          // If we are still supposed to be locking, try again
          if (this.isLocking) {
            this.reAcquireLock();
          }
        });
      } catch (err) {
        console.warn("Native WakeLock failed, relying on video fallback:", err);
      }
    }

    // 2. Video Fallback (For iOS/Android robustness)
    // Plays a 1x1 pixel silent video inline. This forces the display engine to stay awake.
    try {
        if (!this.noSleepVideo) {
            this.noSleepVideo = document.createElement('video');
            this.noSleepVideo.setAttribute('playsinline', 'true'); // Important for iOS
            this.noSleepVideo.setAttribute('muted', 'true');
            this.noSleepVideo.setAttribute('loop', 'true');
            this.noSleepVideo.style.opacity = '0';
            this.noSleepVideo.style.position = 'absolute';
            this.noSleepVideo.style.top = '0';
            this.noSleepVideo.style.left = '0';
            this.noSleepVideo.style.width = '1px';
            this.noSleepVideo.style.height = '1px';
            this.noSleepVideo.style.pointerEvents = 'none';
            this.noSleepVideo.src = NO_SLEEP_VIDEO_BASE64;
            document.body.appendChild(this.noSleepVideo);
        }
        
        // Use a promise to catch "User gesture required" errors
        const playPromise = this.noSleepVideo.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                console.log("Screen Wake Lock: Active (Video Fallback)");
            }).catch(error => {
                // This usually happens if called without a click. 
                // We rely on the App to call this during a click flow.
                console.warn("Video WakeLock blocked (needs gesture):", error);
            });
        }
    } catch (e) {
        console.error("Video fallback failed", e);
    }
  }

  private async reAcquireLock() {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
          try {
            this.wakeLock = await (navigator as any).wakeLock.request('screen');
            this.wakeLock.addEventListener('release', () => {
                if (this.isLocking) this.reAcquireLock();
            });
          } catch (e) { console.log("Re-acquire failed"); }
      }
  }

  public async disableWakeLock() {
    this.isLocking = false;

    // Release Native
    if (this.wakeLock !== null) {
      try {
        await this.wakeLock.release();
        this.wakeLock = null;
      } catch(e) {}
    }

    // Stop Video
    if (this.noSleepVideo) {
        this.noSleepVideo.pause();
        this.noSleepVideo.remove();
        this.noSleepVideo = null;
    }
    console.log("Screen Wake Lock: Disabled");
  }

  public initVisibilityListener() {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && this.isLocking) {
        await this.enableWakeLock();
      }
    });
  }
}

export const deviceService = new DeviceService();
deviceService.initVisibilityListener();
