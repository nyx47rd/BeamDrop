
const ADJECTIVES = ['Red', 'Blue', 'Green', 'Fast', 'Silent', 'Cosmic', 'Neon', 'Swift'];
const ANIMALS = ['Fox', 'Eagle', 'Bear', 'Wolf', 'Hawk', 'Tiger', 'Falcon', 'Panda'];

export class DeviceService {
  private wakeLock: any = null;
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
                navigator.vibrate(200); 
            } catch (e) {
                // Silently ignore vibration errors
            }
        }

        const options: any = {
          body,
          icon: '/icon.svg',
          badge: '/notification-icon.svg',
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
   * Native Wake Lock API
   */
  public async enableWakeLock() {
    if (this.isLocking) return;
    
    if ('wakeLock' in navigator) {
      try {
        this.isLocking = true;
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
        console.log("Screen Wake Lock: Active");

        this.wakeLock.addEventListener('release', () => {
          console.log('Screen Wake Lock: Released by system');
          // Try to reacquire if we still want it
          if (this.isLocking) {
            this.reAcquireLock();
          }
        });
      } catch (err) {
        console.warn("WakeLock request failed:", err);
        this.isLocking = false;
      }
    }
  }

  private async reAcquireLock() {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
          try {
            this.wakeLock = await (navigator as any).wakeLock.request('screen');
            this.wakeLock.addEventListener('release', () => {
                if (this.isLocking) this.reAcquireLock();
            });
          } catch (e) { 
              // Debounce re-acquire or silence error
           }
      }
  }

  public async disableWakeLock() {
    this.isLocking = false;

    if (this.wakeLock !== null) {
      try {
        await this.wakeLock.release();
        this.wakeLock = null;
      } catch(e) {}
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