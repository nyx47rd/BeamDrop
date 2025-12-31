import { SignalingService } from './signaling';
import { deviceService } from './device';

export interface Peer {
  id: string;
  name: string;
  lastSeen: number;
}

export interface Invite {
  fromId: string;
  fromName: string;
  roomId: string;
}

const ANNOUNCE_INTERVAL_MS = 3000;
const PEER_TIMEOUT_MS = 8000;

export class DiscoveryService {
  private signaling: SignalingService;
  private myId: string = Math.random().toString(36).substr(2, 9);
  private peers: Map<string, Peer> = new Map();
  private announceInterval: any = null;
  private cleanupInterval: any = null;
  
  private onPeersUpdate: ((peers: Peer[]) => void) | null = null;
  private onInviteReceived: ((invite: Invite) => void) | null = null;

  // The Room ID will now be dynamic based on Public IP to simulate LAN
  private discoveryRoomId: string | null = null;

  constructor() {
    // Create a dedicated signaling instance for discovery to not interfere with file transfer
    this.signaling = new SignalingService();
  }

  public async init(onPeersUpdate: (peers: Peer[]) => void, onInviteReceived: (invite: Invite) => void) {
    this.onPeersUpdate = onPeersUpdate;
    this.onInviteReceived = onInviteReceived;

    try {
        const publicIp = await this.getPublicIP();
        // Create a unique room ID based on the public IP. 
        // Devices on the same Wi-Fi (NAT) will share this IP and see each other.
        this.discoveryRoomId = `beamdrop-lan-${publicIp.replace(/[^a-zA-Z0-9]/g, '')}`;
        console.log("Discovery: Initializing for Network Group:", publicIp);
        this.connectToLobby();
    } catch (e) {
        console.warn("Discovery: Could not determine Public IP. LAN discovery disabled.", e);
        // If we can't get IP, we don't connect to discovery to avoid polluting a global list.
    }
  }

  // Helper to fetch Public IP (IPv4)
  private async getPublicIP(): Promise<string> {
      try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          
          // Using ipify as a reliable source for Public IP
          // This allows us to group users behind the same NAT
          const response = await fetch('https://api.ipify.org?format=json', { 
              signal: controller.signal,
              cache: 'no-store'
          });
          clearTimeout(timeoutId);
          
          if (!response.ok) throw new Error("IP Fetch failed");
          const data = await response.json();
          return data.ip;
      } catch (e) {
          throw e;
      }
  }

  public stop() {
    if (this.announceInterval) clearInterval(this.announceInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.signaling.disconnect();
    this.peers.clear();
    this.discoveryRoomId = null;
  }

  public updateMyName() {
      // Force immediate announcement with new name
      this.announcePresence();
  }

  private connectToLobby() {
    if (!this.discoveryRoomId) return;

    this.signaling.connect(this.discoveryRoomId, (data) => this.handleMessage(data), () => {
        console.log('Discovery: Connected to Local Network Lobby');
        this.startAnnouncing();
    });
  }

  private startAnnouncing() {
    // Send immediate
    this.announcePresence();
    
    // Send periodic
    if (this.announceInterval) clearInterval(this.announceInterval);
    this.announceInterval = setInterval(() => {
        this.announcePresence();
    }, ANNOUNCE_INTERVAL_MS);

    // Cleanup stale peers
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.cleanupInterval = setInterval(() => {
        const now = Date.now();
        let changed = false;
        this.peers.forEach((peer, id) => {
            if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
                this.peers.delete(id);
                changed = true;
            }
        });
        if (changed) this.emitPeers();
    }, 2000);
  }

  private announcePresence() {
    this.signaling.sendSignal({
        type: 'presence',
        id: this.myId,
        name: deviceService.getDeviceName()
    });
  }

  private handleMessage(data: any) {
    if (data.id === this.myId) return;

    if (data.type === 'presence') {
        const existing = this.peers.get(data.id);
        if (!existing || existing.name !== data.name) {
             this.peers.set(data.id, { id: data.id, name: data.name, lastSeen: Date.now() });
             this.emitPeers();
        } else {
             // Just update timestamp
             existing.lastSeen = Date.now();
        }
    } else if (data.type === 'invite') {
        if (data.targetId === this.myId) {
            if (this.onInviteReceived) {
                this.onInviteReceived({
                    fromId: data.fromId,
                    fromName: data.fromName,
                    roomId: data.roomId
                });
            }
        }
    }
  }

  private emitPeers() {
      if (this.onPeersUpdate) {
          this.onPeersUpdate(Array.from(this.peers.values()));
      }
  }

  public sendInvite(targetPeerId: string, roomId: string) {
      this.signaling.sendSignal({
          type: 'invite',
          targetId: targetPeerId,
          fromId: this.myId,
          fromName: deviceService.getDeviceName(),
          roomId: roomId
      });
  }
}

export const discoveryService = new DiscoveryService();