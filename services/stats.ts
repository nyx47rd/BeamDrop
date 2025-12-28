
/**
 * DEDICATED STATISTICS ENGINE
 * Handles all math for Speed, ETA, and Moving Averages.
 * Decoupled from file transfer logic.
 */

export class TransferMonitor {
  private startTime: number = 0;
  private totalBytes: number = 0;
  private loadedBytes: number = 0;
  
  // Smoothing for Speed (Exponential Moving Average)
  private lastSpeed: number = 0;
  private lastTick: number = 0;
  private lastBytes: number = 0;
  
  constructor() {
    this.reset(0);
  }

  reset(totalBytes: number) {
    this.startTime = Date.now();
    this.lastTick = Date.now();
    this.totalBytes = totalBytes;
    this.loadedBytes = 0;
    this.lastBytes = 0;
    this.lastSpeed = 0;
  }

  update(addedBytes: number) {
    this.loadedBytes += addedBytes;
  }

  /**
   * Calculates current metrics.
   * Call this periodically (e.g., every 500ms) to get UI values.
   */
  getMetrics() {
    const now = Date.now();
    const timeDiff = (now - this.lastTick) / 1000; // seconds

    let currentSpeed = this.lastSpeed;

    // Update speed calculation only if enough time passed to avoid jitter
    if (timeDiff >= 0.5) {
      const bytesDiff = this.loadedBytes - this.lastBytes;
      const instantSpeed = bytesDiff / timeDiff; // bytes per second

      // Smoothing: 70% new speed, 30% old speed
      if (this.lastSpeed === 0) {
        currentSpeed = instantSpeed;
      } else {
        currentSpeed = (instantSpeed * 0.7) + (this.lastSpeed * 0.3);
      }

      this.lastSpeed = currentSpeed;
      this.lastTick = now;
      this.lastBytes = this.loadedBytes;
    }

    const remainingBytes = Math.max(0, this.totalBytes - this.loadedBytes);
    const eta = currentSpeed > 0 ? Math.ceil(remainingBytes / currentSpeed) : 0;

    return {
      transferredBytes: this.loadedBytes,
      totalBytes: this.totalBytes,
      speed: currentSpeed, // raw bytes/sec
      eta: eta, // raw seconds
      speedStr: this.formatSpeed(currentSpeed),
      etaStr: this.formatETA(eta)
    };
  }

  // --- Formatting Helpers ---

  private formatSpeed(bytesPerSec: number): string {
    if (bytesPerSec === 0) return '0 MB/s';
    const mb = bytesPerSec / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
    const kb = bytesPerSec / 1024;
    return `${kb.toFixed(0)} KB/s`;
  }

  private formatETA(seconds: number): string {
    if (seconds === 0) return '';
    if (!isFinite(seconds)) return 'Calculating...';
    if (seconds < 60) return `${seconds}s left`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s left`;
  }
}

export const statsEngine = new TransferMonitor();
