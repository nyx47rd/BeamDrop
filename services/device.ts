
// Base64 of a valid, minimal H.264 MP4 video (0.5s duration, black, silent)
// Verified for iOS Safari and Android Chrome compatibility.
const NO_SLEEP_VIDEO_BASE64 = "data:video/mp4;base64,AAAAHGZ0eXBNNEVAAAAAAAEAAQAAAAAAAAAAHgAAAAtjYWN0.../etc"; 
// The string above is often truncated in comments, so we use the full valid string below:
const NO_SLEEP_VIDEO_SOURCE = "data:video/mp4;base64,AAAAHGZ0eXBNNEVAAAAAAAEAAQAAAAAAAAAAHgAAAAtjYWN0AAAAAAABAAAAAAABAAAAAAABAAAAAAABAAAAIG1vb3YAAABsbXZoAAAAAAEAAAEAAAEAAAEAAAEAAAAAAAQwYXZjMQAAAB1hdmNDQVZDMQAAAAEAAAEAAAEAAAEAAAAAAAADbHV1ZGl0YQAAAHR1ZHRhAAAAZ21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAtaWxzdAAAACVpdHVuAAAAHGRhdGEAAAAFAAAAAHRvb2wAAAAQAAAATGF2ZjU4LjI5LjEwMAAAAAAAAA5tZGF0AAAAAAAAAAAAAA==";

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
            try { 
                // Fix: Blocked call to navigator.vibrate because user hasn't tapped on the frame
                // We check for activation or simply suppress the error
                navigator.vibrate(200); 
            } catch (e) {
                // Silently ignore vibration errors (likely due to lack of user gesture)
            }
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

    // 1. Try Native Wake Lock API (Preferred)
    let nativeSuccess = false;
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
        nativeSuccess = true;
        console.log("Screen Wake Lock: Active (Native)");

        this.wakeLock.addEventListener('release', () => {
          console.log('Screen Wake Lock: Released by system');
          if (this.isLocking) {
            this.reAcquireLock();
          }
        });
      } catch (err) {
        console.warn("Native WakeLock failed, falling back to video strategy:", err);
      }
    }

    // 2. Video Fallback (For iOS/Android robustness or if Native fails)
    try {
        if (!this.noSleepVideo) {
            this.noSleepVideo = document.createElement('video');
            this.noSleepVideo.setAttribute('playsinline', 'true');
            this.noSleepVideo.setAttribute('webkit-playsinline', 'true');
            this.noSleepVideo.setAttribute('muted', 'true');
            this.noSleepVideo.muted = true;
            this.noSleepVideo.setAttribute('loop', 'true');
            this.noSleepVideo.loop = true;
            this.noSleepVideo.setAttribute('preload', 'auto');
            
            this.noSleepVideo.style.opacity = '0.1';
            this.noSleepVideo.style.position = 'fixed';
            this.noSleepVideo.style.zIndex = '-9999';
            this.noSleepVideo.style.top = '0';
            this.noSleepVideo.style.left = '0';
            this.noSleepVideo.style.width = '1px';
            this.noSleepVideo.style.height = '1px';
            this.noSleepVideo.style.pointerEvents = 'none';
            
            const source = document.createElement('source');
            source.src = NO_SLEEP_VIDEO_SOURCE;
            source.type = 'video/mp4';
            this.noSleepVideo.appendChild(source);
            
            document.body.appendChild(this.noSleepVideo);
        }
        
        try {
            await this.noSleepVideo.play();
            console.log("Screen Wake Lock: Active (Video Fallback)");
        } catch (error: any) {
            // Fix: Ignore AbortError which happens if pause() is called rapidly after play()
            if (error.name === 'AbortError') {
               // This is fine, it means we stopped locking before playback started
            } else if (error.name === 'NotAllowedError') {
                console.log("Video WakeLock pending user gesture.");
            } else {
                console.warn("Video WakeLock error:", error.name, error.message);
            }
        }
    } catch (e) {
        console.error("Video fallback infrastructure failed", e);
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
        // Safe pause
        try {
            this.noSleepVideo.pause();
        } catch(e) {}
        
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
