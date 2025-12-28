
// ---------------------------------------------------------------------------
// ⚡️ ADIM 2: CLOUDFLARE WORKER URL'İNİ BURAYA YAPIŞTIR
// Sunucuyu 'npx wrangler deploy' ile yükledikten sonra verdiği wss:// linkini aşağıya gir.
// ---------------------------------------------------------------------------
const CF_WORKER_URL = (import.meta as any).env?.VITE_SIGNALING_URL || 'wss://URL_YI_BURAYA_YAPISTIR';

type SignalingCallback = (data: any) => void;
type ConnectCallback = () => void;

export class SignalingService {
  private ws: WebSocket | null = null;
  private roomId: string | null = null;
  private onSignal: SignalingCallback | null = null;
  private onConnected: ConnectCallback | null = null;
  private keepAliveInterval: any = null;

  async connect(roomId: string, onSignal: SignalingCallback, onConnected?: ConnectCallback) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.roomId === roomId) {
      this.onSignal = onSignal;
      if (onConnected) onConnected();
      return;
    }

    this.disconnect();

    this.roomId = roomId;
    this.onSignal = onSignal;
    this.onConnected = onConnected || null;

    // Kullanıcı URL'yi değiştirmemişse uyarı ver
    if (CF_WORKER_URL.includes('https://beamdrop-server.yasar-123-sevda.workers.dev')) {
      console.error("❌ HATA: Lütfen services/signaling.ts dosyasındaki CF_WORKER_URL değişkenine Cloudflare Worker linkini yapıştırın.");
      alert("Kurulum Tamamlanmadı: Lütfen services/signaling.ts dosyasına sunucu linkini ekleyin.");
      return;
    }

    console.log(`Connecting to CF Worker Signaling: ${CF_WORKER_URL}`);

    try {
      // Connect to Cloudflare Worker with roomId as query param
      this.ws = new WebSocket(`${CF_WORKER_URL}?roomId=${roomId}`);

      this.ws.onopen = () => {
        console.log('Connected to Signaling Server');
        this.startKeepAlive();
        if (this.onConnected) this.onConnected();
      };

      this.ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (this.onSignal) {
            this.onSignal(payload);
          }
        } catch (e) {
          console.error('Failed to parse signal', e);
        }
      };

      this.ws.onerror = (err) => {
        console.error('WebSocket Error:', err);
      };

      this.ws.onclose = () => {
        console.log('WebSocket Closed');
        this.stopKeepAlive();
      };

    } catch (err) {
      console.error("Failed to connect WebSocket", err);
    }
  }

  sendSignal(data: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn("Cannot send signal, WebSocket not connected");
    }
  }

  disconnect() {
    this.stopKeepAlive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.roomId = null;
    this.onSignal = null;
    this.onConnected = null;
  }

  // Cloudflare WebSockets can timeout if idle, so we send a tiny ping occasionally
  // technically CF handles pings, but app-level keepalive is safer
  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Empty object or specific ping type depending on worker logic.
            // Our worker just broadcasts everything, so maybe don't send anything 
            // visible to other peers unless we filter it. 
            // For this simple implementation, standard TCP keepalive is usually enough,
            // but if needed, we can send a dummy message.
            // this.ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);
  }

  private stopKeepAlive() {
    if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval);
        this.keepAliveInterval = null;
    }
  }
}

export const signalingService = new SignalingService();