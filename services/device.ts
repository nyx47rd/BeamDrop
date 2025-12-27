export class DeviceService {
  private wakeLock: any = null;
  private backgroundAudio: HTMLAudioElement | null = null;
  private isPrepared: boolean = false;

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
   * 1. PRIME THE AUDIO ENGINE
   * This MUST be called directly from a React onClick handler.
   */
  public prepareForBackground() {
    if (this.isPrepared) return;

    try {
      // 1 second of silent WAV
      const silentWav = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==';
      
      this.backgroundAudio = new Audio(silentWav);
      this.backgroundAudio.loop = true;
      this.backgroundAudio.volume = 0.01; 
      this.backgroundAudio.preload = 'auto';

      this.backgroundAudio.play().then(() => {
        this.backgroundAudio?.pause();
        this.isPrepared = true;
        console.log("Audio engine unlocked for background persistence");
      }).catch(e => {
        console.warn("Audio unlock failed (user gesture required)", e);
      });

    } catch (e) {
      console.error("Failed to prepare background audio", e);
    }
  }

  /**
   * 2. START BACKGROUND TASK
   * Called when P2P connection is established.
   */
  public enableBackgroundMode() {
    if (!this.backgroundAudio) {
      this.prepareForBackground();
    }

    if (this.backgroundAudio) {
        this.backgroundAudio.play().catch(e => console.error("Bg play failed", e));
    }

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'File Transfer Active',
        artist: 'BeamDrop P2P',
        album: 'Do not close app',
        artwork: [
          { src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml' }
        ]
      });

      navigator.mediaSession.setActionHandler('play', () => { this.backgroundAudio?.play(); });
      navigator.mediaSession.setActionHandler('pause', () => { /* Prevent pausing */ });
      navigator.mediaSession.setActionHandler('stop', () => { /* Prevent stopping */ });
    }
    
    console.log("Background Persistence: ENABLED (Media Session Active)");
  }

  public disableBackgroundMode() {
    if (this.backgroundAudio) {
        this.backgroundAudio.pause();
        this.backgroundAudio.currentTime = 0;
    }
    
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
    }
    console.log("Background Persistence: DISABLED");
  }

  public async enableWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
      } catch (err) {
        console.warn("WakeLock failed:", err);
      }
    }
  }

  public async disableWakeLock() {
    if (this.wakeLock !== null) {
      await this.wakeLock.release();
      this.wakeLock = null;
    }
  }

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