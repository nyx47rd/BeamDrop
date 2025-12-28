
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

const DISCOVERY_ROOM_ID = 'beamdrop-global-lobby-v1';
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

  constructor() {
    // Create a dedicated signaling instance for discovery to not interfere with file transfer
    this.signaling = new SignalingService();
  }

  public init(onPeersUpdate: (peers: Peer[]) => void, onInviteReceived: (invite: Invite) => void) {
    this.onPeersUpdate = onPeersUpdate;
    this.onInviteReceived = onInviteReceived;

    this.connectToLobby();
  }

  public stop() {
    if (this.announceInterval) clearInterval(this.announceInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.signaling.disconnect();
    this.peers.clear();
  }

  public updateMyName() {
      // Force immediate announcement with new name
      this.announcePresence();
  }

  private connectToLobby() {
    this.signaling.connect(DISCOVERY_ROOM_ID, (data) => this.handleMessage(data), () => {
        console.log('Discovery: Connected to Lobby');
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
