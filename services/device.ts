export class DeviceService {
  private wakeLock: any = null;
  private backgroundAudio: HTMLAudioElement | null = null;
  private isPrepared: boolean = false;

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
      try {
        if ('vibrate' in navigator) navigator.vibrate(200);

        new Notification(title, {
          body,
          icon: '/icon.svg',
          badge: '/icon.svg',
          tag: 'beamdrop-transfer',
          renotify: true,
          requireInteraction: false
        } as any);
      } catch (e) {
        console.error("Notification failed", e);
      }
    }
  }

  /**
   * 1. PRIME THE AUDIO ENGINE
   * This MUST be called directly from a React onClick handler (Sender/Receiver selection).
   * It initializes the audio object and plays/pauses it to unlock the browser's audio context.
   */
  public prepareForBackground() {
    if (this.isPrepared) return;

    try {
      // A slightly longer silent track (WAV) to ensure metadata loads correctly
      // This is 1 second of silence.
      const silentWav = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==';
      
      this.backgroundAudio = new Audio(silentWav);
      this.backgroundAudio.loop = true;
      this.backgroundAudio.volume = 0.01; // iOS sometimes ignores volume 0
      this.backgroundAudio.preload = 'auto';

      // "Touch" the audio to unlock autoplay limits
      this.backgroundAudio.play().then(() => {
        // Immediately pause after first touch, we will resume when connection starts
        this.backgroundAudio?.pause();
        this.isPrepared = true;
        console.log("Audio engine unlocked for background persistence");
      }).catch(e => {
        console.warn("Audio unlock failed (must be triggered by user gesture)", e);
      });

    } catch (e) {
      console.error("Failed to prepare background audio", e);
    }
  }

  /**
   * 2. START BACKGROUND TASK
   * Called when P2P connection is established.
   * Resumes the looped audio and sets Media Session metadata.
   */
  public enableBackgroundMode() {
    if (!this.backgroundAudio) {
      this.prepareForBackground(); // Last ditch attempt
    }

    if (this.backgroundAudio) {
        this.backgroundAudio.play().catch(e => console.error("Bg play failed", e));
    }

    // Set Media Session Metadata
    // This puts the "Now Playing" widget on the lock screen, which is CRITICAL for iOS background execution.
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'File Transfer Active',
        artist: 'BeamDrop P2P',
        album: 'Do not close app',
        artwork: [
          { src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml' }
        ]
      });

      // Add dummy handlers to prevent the "Pause" button from killing the app
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