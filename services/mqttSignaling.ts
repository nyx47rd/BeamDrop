import type { MqttClient } from 'mqtt';

// Using HiveMQ public broker which often has better WSS support/uptime for demos
const BROKER_URL = 'wss://broker.hivemq.com:8884/mqtt';

type SignalingCallback = (data: any) => void;
type ConnectCallback = () => void;

export class SignalingService {
  private client: MqttClient | null = null;
  private roomId: string | null = null;
  private onSignal: SignalingCallback | null = null;
  private onConnected: ConnectCallback | null = null;

  async connect(roomId: string, onSignal: SignalingCallback, onConnected?: ConnectCallback) {
    // If already connected to this room, just update callback
    if (this.client && this.client.connected && this.roomId === roomId) {
      this.onSignal = onSignal;
      if (onConnected) onConnected();
      return;
    }

    // Disconnect previous if exists
    this.disconnect();

    this.roomId = roomId;
    this.onSignal = onSignal;
    this.onConnected = onConnected || null;

    const clientId = 'beamdrop_v3_' + Math.random().toString(16).substring(2, 10);
    
    console.log(`Loading MQTT module and connecting to: ${BROKER_URL}`);

    try {
      // DYNAMIC IMPORT: This prevents 'mqtt' from bloating the initial bundle.
      // It is only downloaded when the user actually tries to connect.
      const mqtt = (await import('mqtt')).default;

      this.client = mqtt.connect(BROKER_URL, {
        clientId,
        clean: true,
        keepalive: 15,
        reconnectPeriod: 1000,
        connectTimeout: 10 * 1000,
      });

      this.client.on('connect', () => {
        console.log('Connected to Signaling Broker');
        if (this.roomId) {
          const topic = `beamdrop-v3/room/${this.roomId}`;
          this.client?.subscribe(topic, { qos: 0 }, (err) => {
            if (!err) {
              console.log(`Subscribed to topic: ${topic}`);
              if (this.onConnected) this.onConnected();
            } else {
              console.error("Subscription error:", err);
            }
          });
        }
      });

      this.client.on('error', (err) => {
        console.error('MQTT Error:', err);
      });

      this.client.on('offline', () => {
        console.log('MQTT Offline');
      });

      this.client.on('message', (topic, message) => {
        try {
          const payload = JSON.parse(message.toString());
          if (this.onSignal) {
            this.onSignal(payload);
          }
        } catch (e) {
          console.error('Failed to parse signal', e);
        }
      });

    } catch (err) {
      console.error("Failed to load MQTT library", err);
    }
  }

  sendSignal(data: any) {
    if (this.client && this.client.connected && this.roomId) {
      const topic = `beamdrop-v3/room/${this.roomId}`;
      this.client.publish(topic, JSON.stringify(data));
    } else {
      console.warn("Cannot send signal, MQTT not connected");
    }
  }

  disconnect() {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
    this.roomId = null;
    this.onSignal = null;
    this.onConnected = null;
  }
}

export const signalingService = new SignalingService();